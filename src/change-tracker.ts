import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface PendingEdit {
  filePath: string;
  beforeLines: string[];
}

interface FileDecorationRanges {
  added: vscode.Range[];
  modified: vscode.Range[];
}

interface TrackedFile {
  decorations: FileDecorationRanges;
  beforeContent: string; // original content for revert on reject
}

export class ChangeTracker {
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly modifiedDecoration: vscode.TextEditorDecorationType;

  private pendingEdits = new Map<string, PendingEdit>();
  private trackedFiles = new Map<string, TrackedFile>();
  private disposables: vscode.Disposable[] = [];

  private readonly codeLensProvider: ChangeCodeLensProvider;
  private readonly _onDidChange = new vscode.EventEmitter<void>();

  constructor() {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.codeLensProvider = new ChangeCodeLensProvider(this.trackedFiles, () => this.normalizePath);

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.reapplyAllDecorations();
      }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLensProvider),
    );
  }

  /** Returns the list of file paths that have pending changes. */
  get trackedFilePaths(): string[] {
    return Array.from(this.trackedFiles.keys());
  }

  /**
   * Snapshot a file's current content before the CLI modifies it,
   * and auto-open it in the editor.
   */
  async snapshotFile(toolUseId: string, filePath: string): Promise<void> {
    const absPath = this.resolveFilePath(filePath);

    let beforeLines: string[] = [];
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      beforeLines = content.split('\n');
    } catch {
      // File doesn't exist yet (Write creating a new file) — empty snapshot
    }

    this.pendingEdits.set(toolUseId, { filePath: absPath, beforeLines });

    // Auto-open the file in the editor without stealing focus
    try {
      const uri = vscode.Uri.file(absPath);
      await vscode.window.showTextDocument(uri, {
        preserveFocus: true,
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      // File may not exist yet for Write tool — will open after creation
    }
  }

  /**
   * Called when a tool result arrives. Reads the file again, computes a diff,
   * and applies decorations to the changed lines.
   */
  async onToolResult(toolUseId: string): Promise<void> {
    const pending = this.pendingEdits.get(toolUseId);
    if (!pending) {
      return;
    }
    this.pendingEdits.delete(toolUseId);

    const { filePath, beforeLines } = pending;

    let afterLines: string[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      afterLines = content.split('\n');
    } catch {
      return;
    }

    const { added, modified } = this.computeDiff(beforeLines, afterLines);

    // Get or create tracked file entry
    const existing = this.trackedFiles.get(filePath);
    const decorations: FileDecorationRanges = existing
      ? { added: this.mergeRanges(existing.decorations.added, added), modified: this.mergeRanges(existing.decorations.modified, modified) }
      : { added, modified };

    // Keep the earliest before-content so reject reverts to the original state
    const beforeContent = existing ? existing.beforeContent : beforeLines.join('\n');

    this.trackedFiles.set(filePath, { decorations, beforeContent });

    this.applyDecorationsForFile(filePath);
    this.revealFirstChange(filePath, added, modified);
    this.codeLensProvider.refresh();

    // For Write tool creating a new file, open it now
    if (beforeLines.length === 0 && afterLines.length > 0) {
      try {
        const uri = vscode.Uri.file(filePath);
        await vscode.window.showTextDocument(uri, {
          preserveFocus: true,
          preview: false,
          viewColumn: vscode.ViewColumn.One,
        });
        this.applyDecorationsForFile(filePath);
      } catch {
        // Best effort
      }
    }
  }

  /** Accept changes for a file — clears decorations and codelens, keeps file as-is. */
  acceptFile(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    const key = this.findTrackedKey(normalized);
    if (!key) { return; }

    this.trackedFiles.delete(key);
    this.clearDecorationsForFile(key);
    this.codeLensProvider.refresh();
  }

  /** Reject changes for a file — reverts to before-content and clears decorations. */
  async rejectFile(filePath: string): Promise<void> {
    const normalized = this.normalizePath(filePath);
    const key = this.findTrackedKey(normalized);
    if (!key) { return; }

    const tracked = this.trackedFiles.get(key);
    if (!tracked) { return; }

    // Write the original content back to disk
    try {
      fs.writeFileSync(key, tracked.beforeContent, 'utf-8');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to revert file: ${err}`);
      return;
    }

    this.trackedFiles.delete(key);
    this.clearDecorationsForFile(key);
    this.codeLensProvider.refresh();

    // Reload the file in the editor to show reverted content
    const uri = vscode.Uri.file(key);
    const doc = vscode.workspace.textDocuments.find(
      (d) => this.normalizePath(d.uri.fsPath) === normalized,
    );
    if (doc) {
      // Revert the in-memory document to match disk
      await vscode.commands.executeCommand('workbench.action.files.revert', uri);
    }
  }

  /** Accept all tracked files. */
  acceptAll(): void {
    for (const key of [...this.trackedFiles.keys()]) {
      this.trackedFiles.delete(key);
      this.clearDecorationsForFile(key);
    }
    this.codeLensProvider.refresh();
  }

  /** Clear all decorations and state (e.g. on new chat). */
  clearDecorations(): void {
    this.trackedFiles.clear();
    this.pendingEdits.clear();

    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.modifiedDecoration, []);
    }
    this.codeLensProvider.refresh();
  }

  dispose(): void {
    this.clearDecorations();
    this.addedDecoration.dispose();
    this.modifiedDecoration.dispose();
    this._onDidChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // ─── Private helpers ───

  private findTrackedKey(normalizedPath: string): string | undefined {
    for (const key of this.trackedFiles.keys()) {
      if (this.normalizePath(key) === normalizedPath) {
        return key;
      }
    }
    return undefined;
  }

  private resolveFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      return path.join(workspaceFolder, filePath);
    }
    return filePath;
  }

  private computeDiff(
    beforeLines: string[],
    afterLines: string[],
  ): { added: vscode.Range[]; modified: vscode.Range[] } {
    const added: vscode.Range[] = [];
    const modified: vscode.Range[] = [];

    if (beforeLines.length === 0) {
      if (afterLines.length > 0) {
        added.push(new vscode.Range(0, 0, afterLines.length - 1, afterLines[afterLines.length - 1].length));
      }
      return { added, modified };
    }

    let prefixLen = 0;
    const minLen = Math.min(beforeLines.length, afterLines.length);
    while (prefixLen < minLen && beforeLines[prefixLen] === afterLines[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < (minLen - prefixLen) &&
      beforeLines[beforeLines.length - 1 - suffixLen] === afterLines[afterLines.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const afterChangeStart = prefixLen;
    const afterChangeEnd = afterLines.length - suffixLen;
    const beforeChangeLen = (beforeLines.length - suffixLen) - prefixLen;
    const afterChangeLen = afterChangeEnd - afterChangeStart;

    if (afterChangeLen <= 0 && beforeChangeLen <= 0) {
      return { added, modified };
    }

    const overlapLen = Math.min(beforeChangeLen, afterChangeLen);
    for (let i = 0; i < overlapLen; i++) {
      const line = afterChangeStart + i;
      modified.push(new vscode.Range(line, 0, line, afterLines[line].length));
    }

    for (let i = overlapLen; i < afterChangeLen; i++) {
      const line = afterChangeStart + i;
      added.push(new vscode.Range(line, 0, line, afterLines[line].length));
    }

    return { added, modified };
  }

  private mergeRanges(existing: vscode.Range[], newRanges: vscode.Range[]): vscode.Range[] {
    const merged = [...existing];
    for (const r of newRanges) {
      if (!merged.some((e) => e.start.line === r.start.line && e.end.line === r.end.line)) {
        merged.push(r);
      }
    }
    return merged;
  }

  private applyDecorationsForFile(filePath: string): void {
    const tracked = this.trackedFiles.get(filePath);
    if (!tracked) { return; }

    for (const editor of vscode.window.visibleTextEditors) {
      if (this.normalizePath(editor.document.uri.fsPath) === this.normalizePath(filePath)) {
        editor.setDecorations(this.addedDecoration, tracked.decorations.added);
        editor.setDecorations(this.modifiedDecoration, tracked.decorations.modified);
      }
    }
  }

  private clearDecorationsForFile(filePath: string): void {
    const norm = this.normalizePath(filePath);
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.normalizePath(editor.document.uri.fsPath) === norm) {
        editor.setDecorations(this.addedDecoration, []);
        editor.setDecorations(this.modifiedDecoration, []);
      }
    }
  }

  private reapplyAllDecorations(): void {
    for (const [filePath] of this.trackedFiles) {
      this.applyDecorationsForFile(filePath);
    }
  }

  private revealFirstChange(
    filePath: string,
    added: vscode.Range[],
    modified: vscode.Range[],
  ): void {
    const allRanges = [...modified, ...added];
    if (allRanges.length === 0) { return; }

    allRanges.sort((a, b) => a.start.line - b.start.line);
    const firstRange = allRanges[0];

    for (const editor of vscode.window.visibleTextEditors) {
      if (this.normalizePath(editor.document.uri.fsPath) === this.normalizePath(filePath)) {
        editor.revealRange(firstRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        break;
      }
    }
  }

  normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }
}

// ─── CodeLens Provider ───

class ChangeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly trackedFiles: Map<string, TrackedFile>,
    private readonly getNormalize: () => (p: string) => string,
  ) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const normalize = this.getNormalize();
    const docPath = normalize(document.uri.fsPath);

    // Find the tracked file matching this document
    let tracked: TrackedFile | undefined;
    let filePath: string | undefined;
    for (const [key, value] of this.trackedFiles) {
      if (normalize(key) === docPath) {
        tracked = value;
        filePath = key;
        break;
      }
    }

    if (!tracked || !filePath) {
      return [];
    }

    // Find the earliest changed line to place the codelens
    const allRanges = [...tracked.decorations.modified, ...tracked.decorations.added];
    if (allRanges.length === 0) {
      return [];
    }

    allRanges.sort((a, b) => a.start.line - b.start.line);
    const firstLine = allRanges[0].start.line;
    const codeLensLine = Math.max(0, firstLine);
    const range = new vscode.Range(codeLensLine, 0, codeLensLine, 0);

    return [
      new vscode.CodeLens(range, {
        title: '$(check) Accept Changes',
        command: 'neusis-code.acceptFileChanges',
        arguments: [filePath],
      }),
      new vscode.CodeLens(range, {
        title: '$(discard) Reject Changes',
        command: 'neusis-code.rejectFileChanges',
        arguments: [filePath],
      }),
    ];
  }
}
