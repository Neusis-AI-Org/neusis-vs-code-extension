import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ClaudeProcess } from './claude-process';
import { ChangeTracker } from './change-tracker';
import { ApprovalServer, ToolApprovalRequest } from './approval-server';
import {
  ClaudeSystemMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeStreamEvent,
  ClaudeResultMessage,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  ContentDelta,
  PermissionMode,
} from './types';

export class NeusisChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'neusis-code.chatView';

  private webviewView?: vscode.WebviewView;
  private claudeProcess: ClaudeProcess;
  public readonly changeTracker: ChangeTracker;
  private approvalServer: ApprovalServer | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private approvalCounter = 0;
  private hookDir: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.claudeProcess = new ClaudeProcess();
    this.changeTracker = new ChangeTracker();
    this.setupProcessListeners();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      this.handleWebviewMessage(msg);
    });

    // Sync current permission mode to the webview dropdown
    const config = vscode.workspace.getConfiguration('neusis-code');
    const currentMode = config.get<PermissionMode>('permissionMode', 'autoEdit');
    this.postMessage({ type: 'modeSync', mode: currentMode });

    webviewView.onDidDispose(() => {
      this.claudeProcess.stop();
      this.changeTracker.dispose();
      this.cleanupApprovalSetup();
    });
  }

  public newChat(): void {
    this.claudeProcess.stop();
    this.changeTracker.clearDecorations();
    this.postMessage({ type: 'clear' });
    this.postMessage({ type: 'stateChange', state: 'idle' });
  }

  public stopGeneration(): void {
    this.claudeProcess.stop();
    this.postMessage({ type: 'stateChange', state: 'idle' });
  }

  private handleWebviewMessage(msg: WebviewToExtensionMessage): void {
    switch (msg.type) {
      case 'sendMessage':
        this.handleSendMessage(msg.text);
        break;
      case 'stopGeneration':
        this.stopGeneration();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'modeChange':
        this.handleModeChange(msg.mode);
        break;
      case 'approvalResponse':
        this.handleApprovalResponse(msg.requestId, msg.approved);
        break;
    }
  }

  private handleModeChange(mode: PermissionMode): void {
    const config = vscode.workspace.getConfiguration('neusis-code');
    config.update('permissionMode', mode, vscode.ConfigurationTarget.Global);

    // If a conversation is active, restart with the new mode on next message.
    // Stop current process so next message starts fresh with new permissions.
    if (this.claudeProcess.isRunning) {
      this.claudeProcess.stop();
      this.postMessage({ type: 'stateChange', state: 'idle' });
    }
  }

  private handleApprovalResponse(requestId: string, approved: boolean): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (resolver) {
      resolver(approved);
      this.pendingApprovals.delete(requestId);
    }
  }

  private requestApprovalFromWebview(_request: ToolApprovalRequest, detail: string, toolName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = `approval-${++this.approvalCounter}`;
      this.pendingApprovals.set(requestId, resolve);
      this.postMessage({
        type: 'approvalRequest',
        requestId,
        toolName,
        detail,
      });
    });
  }

  private handleSendMessage(text: string): void {
    if (!text.trim()) {return;}

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    // If process isn't running, start it and send the first message
    if (!this.claudeProcess.isRunning) {
      const config = vscode.workspace.getConfiguration('neusis-code');
      const mode = config.get<string>('permissionMode', 'autoEdit');

      this.startProcess(cwd, mode).then(() => {
        this.postMessage({ type: 'stateChange', state: 'waiting' });
        // Small delay to let the process initialize before sending
        setTimeout(() => {
          this.claudeProcess.sendMessage(text);
        }, 500);
      }).catch((err: Error) => {
        vscode.window.showErrorMessage(`Failed to start Claude: ${err.message}`);
      });
    } else {
      this.postMessage({ type: 'stateChange', state: 'waiting' });
      this.claudeProcess.sendMessage(text);
    }
  }

  private async startProcess(cwd: string, mode: string): Promise<void> {
    switch (mode) {
      case 'planFirst':
        this.claudeProcess.start(cwd, 'plan');
        break;
      case 'autoEdit':
        this.claudeProcess.start(cwd, 'bypassPermissions');
        break;
      case 'askFirst': {
        const settingsPath = await this.ensureApprovalSetup();
        this.claudeProcess.start(cwd, 'bypassPermissions', settingsPath);
        break;
      }
      default:
        this.claudeProcess.start(cwd, 'bypassPermissions');
    }
  }

  /**
   * Set up the approval server and hook files for "Ask before edits" mode.
   * Returns the path to the generated settings JSON file.
   */
  private async ensureApprovalSetup(): Promise<string> {
    // Start the approval HTTP server if not already running
    if (!this.approvalServer) {
      this.approvalServer = new ApprovalServer((request, detail) => {
        return this.requestApprovalFromWebview(request, detail, request.toolName);
      });
      await this.approvalServer.start();
    }

    // Create temp directory for hook files if needed
    if (!this.hookDir) {
      this.hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neusis-code-'));
    }

    const port = this.approvalServer.port;
    const hookScriptPath = path.join(this.hookDir, 'approval-hook.js');
    const settingsPath = path.join(this.hookDir, 'settings.json');

    // Write the hook script
    fs.writeFileSync(hookScriptPath, this.generateHookScript(port), 'utf-8');

    // Write the settings JSON with hook configuration
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: `node "${hookScriptPath.replace(/\\/g, '/')}"`,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    return settingsPath;
  }

  private generateHookScript(port: number): string {
    return `const http = require('http');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }
  const toolName = data.tool_name || '';
  const safeTools = ['Read', 'Glob', 'Grep', 'LS', 'Task', 'TodoRead', 'TodoWrite'];
  if (safeTools.includes(toolName)) { process.exit(0); }
  const body = JSON.stringify({ toolName, toolInput: JSON.stringify(data.tool_input || {}) });
  const req = http.request({
    hostname: '127.0.0.1', port: ${port}, path: '/approve', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 120000,
  }, (res) => {
    let rb = '';
    res.on('data', (c) => { rb += c; });
    res.on('end', () => {
      try {
        const result = JSON.parse(rb);
        const out = { hookSpecificOutput: { hookEventName: 'PreToolUse',
          permissionDecision: result.approved ? 'allow' : 'deny',
          permissionDecisionReason: result.approved ? '' : 'User denied this tool use' } };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      } catch { process.exit(2); }
    });
  });
  req.on('error', () => { process.exit(2); });
  req.on('timeout', () => { req.destroy(); process.exit(2); });
  req.write(body);
  req.end();
});
`;
  }

  private cleanupApprovalSetup(): void {
    // Deny any pending approval requests
    for (const resolver of this.pendingApprovals.values()) {
      resolver(false);
    }
    this.pendingApprovals.clear();

    if (this.approvalServer) {
      this.approvalServer.stop();
      this.approvalServer = null;
    }
    if (this.hookDir) {
      try {
        fs.rmSync(this.hookDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      this.hookDir = null;
    }
  }

  private setupProcessListeners(): void {
    this.claudeProcess.on('system', (msg: ClaudeSystemMessage) => {
      if (msg.subtype === 'init') {
        this.postMessage({
          type: 'sessionInit',
          model: msg.model || 'unknown',
          tools: msg.tools || [],
          sessionId: msg.session_id,
        });
      }
    });

    this.claudeProcess.on('streamEvent', (msg: ClaudeStreamEvent) => {
      const event = msg.event;

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use' && event.content_block.id && event.content_block.name) {
          const input = event.content_block.input as Record<string, unknown> | undefined;
          let summary: string | undefined;
          if (input) {
            const name = event.content_block.name;
            if (input.file_path) { summary = String(input.file_path); }
            else if (input.command) { summary = String(input.command).slice(0, 80); }
            else if (input.pattern) { summary = String(input.pattern); }
            else if (name === 'Task' && input.description) { summary = String(input.description); }
          }
          this.postMessage({
            type: 'toolUseStart',
            id: event.content_block.id,
            name: event.content_block.name,
            summary,
          });
        }
        this.postMessage({ type: 'stateChange', state: 'streaming' });
      }

      if (event.type === 'content_block_delta') {
        const delta = event.delta as ContentDelta;
        if (delta.type === 'text_delta') {
          this.postMessage({ type: 'streamText', text: delta.text });
        }
      }
    });

    this.claudeProcess.on('assistant', (msg: ClaudeAssistantMessage) => {
      this.postMessage({
        type: 'assistantMessage',
        content: msg.message.content,
      });

      // Snapshot files before the CLI executes Edit/Write tools.
      // The assistant event has the complete tool input (unlike content_block_start
      // where input is streamed incrementally) and fires before tool execution.
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write') && block.input.file_path) {
          this.changeTracker.snapshotFile(block.id, String(block.input.file_path));
        }
      }
    });

    this.claudeProcess.on('user', (msg: ClaudeUserMessage) => {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          this.postMessage({
            type: 'toolResult',
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: block.is_error,
          });

          // Diff and decorate changed lines in the editor
          this.changeTracker.onToolResult(block.tool_use_id);
        }
      }
    });

    this.claudeProcess.on('result', (msg: ClaudeResultMessage) => {
      this.postMessage({
        type: 'resultMessage',
        result: msg.result || (msg.errors?.join('\n') ?? ''),
        cost: msg.total_cost_usd,
        duration: msg.duration_ms,
        isError: msg.is_error,
      });
      this.postMessage({ type: 'stateChange', state: 'idle' });
    });

    this.claudeProcess.on('error', (err: Error) => {
      console.error('[Neusis Code]', err.message);
      this.postMessage({ type: 'errorMessage', message: err.message });
      this.postMessage({ type: 'stateChange', state: 'error' });
    });

    this.claudeProcess.on('exit', (code: number | null) => {
      if (code !== 0 && code !== null) {
        this.postMessage({
          type: 'errorMessage',
          message: `Claude process exited with code ${code}. Make sure the Claude CLI is installed and available in your PATH.`,
        });
        this.postMessage({ type: 'stateChange', state: 'error' });
      } else {
        this.postMessage({ type: 'stateChange', state: 'idle' });
      }
    });
  }

  private postMessage(msg: ExtensionToWebviewMessage): void {
    this.webviewView?.webview.postMessage(msg);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Neusis Code</title>
  <style>
    :root {
      /* ─── Base tokens ─── */
      --font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --mono-font: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --input-placeholder: var(--vscode-input-placeholderForeground, rgba(204,204,204,0.5));
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover-bg: var(--vscode-button-hoverBackground);
      --button-secondary-bg: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08));
      --button-secondary-fg: var(--vscode-button-secondaryForeground, var(--fg));
      --button-secondary-hover: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.14));
      --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
      --focus-border: var(--vscode-focusBorder, var(--button-bg));
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --link-fg: var(--vscode-textLink-foreground);
      --link-hover: var(--vscode-textLink-activeForeground, var(--link-fg));
      --code-bg: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
      --sidebar-bg: var(--vscode-sideBar-background, var(--bg));
      --sidebar-fg: var(--vscode-sideBar-foreground, var(--fg));
      --section-header-bg: var(--vscode-sideBarSectionHeader-background, transparent);
      --section-header-fg: var(--vscode-sideBarSectionHeader-foreground, var(--fg));
      --description-fg: var(--vscode-descriptionForeground, rgba(204,204,204,0.7));
      --toolbar-hover-bg: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12));
      --list-hover-bg: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
      --error-fg: var(--vscode-errorForeground, #f44);
      --warning-fg: var(--vscode-editorWarning-foreground, #cca700);
      --success-fg: var(--vscode-testing-iconPassed, #73c991);
      --scrollbar-bg: var(--vscode-scrollbarSlider-background, rgba(255,255,255,0.1));
      --scrollbar-hover: var(--vscode-scrollbarSlider-hoverBackground, rgba(255,255,255,0.2));

      /* ─── Spacing & shape ─── */
      --sp-xs: 4px;
      --sp-sm: 6px;
      --sp-md: 10px;
      --sp-lg: 14px;
      --sp-xl: 20px;
      --radius-sm: 3px;
      --radius-md: 6px;
      --radius-lg: 10px;
      --icon-size: 16px;
      --icon-sm: 14px;
      --avatar-size: 22px;
      --transition-fast: 120ms ease;
      --transition-normal: 200ms ease;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      font-family: var(--font-family);
      font-size: var(--font-size);
      background: var(--sidebar-bg);
      color: var(--sidebar-fg);
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
    }

    /* ─── Utility ─── */
    .icon {
      width: var(--icon-size);
      height: var(--icon-size);
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      flex-shrink: 0;
      vertical-align: middle;
    }
    .icon-sm { width: var(--icon-sm); height: var(--icon-sm); }
    .hidden { display: none !important; }

    /* ─── Header ─── */
    .header {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-sm) var(--sp-md);
      background: var(--section-header-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 34px;
    }
    .header-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--section-header-fg);
      flex-shrink: 0;
    }
    .model-badge {
      font-size: 10px;
      color: var(--description-fg);
      background: var(--list-hover-bg);
      padding: 1px 6px;
      border-radius: 9px;
      font-weight: 500;
      white-space: nowrap;
      display: none;
    }
    .model-badge.visible { display: inline-block; }
    .header-spacer { flex: 1; }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .mode-select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-sm);
      padding: 2px 18px 2px 6px;
      font-family: var(--font-family);
      font-size: 11px;
      cursor: pointer;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath fill='%23888' d='M0 2l4 4 4-4z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 4px center;
      transition: border-color var(--transition-fast);
    }
    .mode-select:hover { border-color: var(--focus-border); }
    .mode-select:focus { border-color: var(--focus-border); }
    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      color: var(--sidebar-fg);
      cursor: pointer;
      padding: var(--sp-xs);
      border-radius: var(--radius-sm);
      opacity: 0.75;
      transition: opacity var(--transition-fast), background var(--transition-fast);
    }
    .icon-btn:hover {
      opacity: 1;
      background: var(--toolbar-hover-bg);
    }

    /* ─── Messages area ─── */
    .messages {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--sp-md) var(--sp-md) var(--sp-lg);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* ─── Message entrance animation ─── */
    @keyframes messageIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .message {
      max-width: 100%;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: break-word;
      animation: messageIn 200ms ease both;
    }

    /* ─── User message ─── */
    .msg-row-user {
      display: flex;
      justify-content: flex-end;
      align-items: flex-end;
      gap: var(--sp-sm);
      margin-top: var(--sp-md);
      animation: messageIn 200ms ease both;
    }
    .msg-row-user .avatar {
      width: var(--avatar-size);
      height: var(--avatar-size);
      border-radius: 50%;
      background: var(--button-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--button-fg);
    }
    .msg-row-user .avatar .icon { stroke: var(--button-fg); width: 13px; height: 13px; }
    .message-user {
      background: var(--button-bg);
      color: var(--button-fg);
      padding: var(--sp-sm) var(--sp-md);
      border-radius: var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg);
      max-width: 82%;
      font-size: 0.93em;
    }

    /* ─── Assistant message ─── */
    .msg-row-assistant {
      display: flex;
      align-items: flex-start;
      gap: var(--sp-sm);
      margin-top: var(--sp-md);
      animation: messageIn 200ms ease both;
    }
    .msg-row-assistant .avatar {
      width: var(--avatar-size);
      height: var(--avatar-size);
      border-radius: 50%;
      background: var(--badge-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
      color: var(--badge-fg);
    }
    .msg-row-assistant .avatar .icon { stroke: var(--badge-fg); width: 13px; height: 13px; }
    .message-assistant {
      flex: 1;
      min-width: 0;
      padding: var(--sp-xs) 0;
      font-size: 0.93em;
    }

    /* ─── Markdown typography ─── */
    .message-assistant p { margin: var(--sp-xs) 0; }
    .message-assistant h3 {
      font-size: 1.05em;
      font-weight: 600;
      margin: var(--sp-md) 0 var(--sp-xs);
    }
    .message-assistant h4 {
      font-size: 0.98em;
      font-weight: 600;
      margin: var(--sp-sm) 0 var(--sp-xs);
    }
    .message-assistant h5 {
      font-size: 0.93em;
      font-weight: 600;
      margin: var(--sp-sm) 0 var(--sp-xs);
      color: var(--description-fg);
    }
    .message-assistant ul, .message-assistant ol {
      margin: var(--sp-xs) 0 var(--sp-xs) var(--sp-lg);
      padding-left: var(--sp-xs);
    }
    .message-assistant li { margin: 2px 0; }
    .message-assistant blockquote {
      border-left: 3px solid var(--border);
      padding-left: var(--sp-md);
      margin: var(--sp-sm) 0;
      color: var(--description-fg);
      font-style: italic;
    }
    .message-assistant hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: var(--sp-md) 0;
    }
    .message-assistant a {
      color: var(--link-fg);
      text-decoration: none;
    }
    .message-assistant a:hover {
      color: var(--link-hover);
      text-decoration: underline;
    }
    .message-assistant code {
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: var(--radius-sm);
      font-family: var(--mono-font);
      font-size: 0.9em;
    }
    .message-assistant pre {
      background: var(--code-bg);
      padding: var(--sp-md) var(--sp-md);
      border-radius: var(--radius-md);
      overflow-x: auto;
      margin: var(--sp-sm) 0;
      font-size: 0.88em;
      line-height: 1.5;
      border: 1px solid var(--border);
    }
    .message-assistant pre code {
      background: none;
      padding: 0;
      font-size: inherit;
    }

    /* ─── Tool card (collapsible) ─── */
    .tool-card {
      margin: var(--sp-xs) 0;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      overflow: hidden;
      animation: fadeIn 150ms ease both;
    }
    .tool-card-header {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-sm) var(--sp-md);
      background: var(--code-bg);
      cursor: pointer;
      user-select: none;
      transition: background var(--transition-fast);
      min-height: 30px;
    }
    .tool-card-header:hover {
      background: var(--list-hover-bg);
    }
    .tool-card-icon {
      color: var(--description-fg);
      flex-shrink: 0;
    }
    .tool-card-name {
      font-weight: 600;
      font-size: 0.88em;
      color: var(--link-fg);
      flex-shrink: 0;
    }
    .tool-card-summary {
      font-size: 0.83em;
      color: var(--description-fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
      font-family: var(--mono-font);
    }
    .tool-card-status {
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }
    .tool-card-status .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--button-bg);
      animation: dotPulse 1.2s ease infinite;
    }
    .tool-card-status .status-done { color: var(--success-fg); }
    .tool-card-status .status-error { color: var(--error-fg); }
    .tool-card-chevron {
      flex-shrink: 0;
      color: var(--description-fg);
      transition: transform var(--transition-normal);
    }
    .tool-card-chevron.rotated {
      transform: rotate(90deg);
    }
    .tool-card-body {
      max-height: 0;
      overflow: hidden;
      transition: max-height 250ms ease;
    }
    .tool-card-body.expanded {
      max-height: 300px;
    }
    .tool-card-body-inner {
      padding: var(--sp-sm) var(--sp-md);
      font-family: var(--mono-font);
      font-size: 0.82em;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--description-fg);
      max-height: 280px;
      overflow-y: auto;
      border-top: 1px solid var(--border);
    }

    @keyframes dotPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* ─── Approval card ─── */
    .approval-card {
      border: 1px solid var(--warning-fg);
      border-radius: var(--radius-md);
      padding: var(--sp-md);
      margin: var(--sp-xs) 0;
      background: var(--code-bg);
      animation: fadeIn 150ms ease both;
    }
    .approval-card.resolved { opacity: 0.65; }
    .approval-header {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      font-size: 0.88em;
      font-weight: 600;
      margin-bottom: var(--sp-sm);
    }
    .approval-header .approval-icon { color: var(--warning-fg); }
    .approval-header .approval-tool-name { color: var(--link-fg); }
    .approval-detail {
      font-family: var(--mono-font);
      font-size: 0.82em;
      background: rgba(0,0,0,0.12);
      border-radius: var(--radius-sm);
      padding: var(--sp-sm) var(--sp-md);
      margin-bottom: var(--sp-md);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 180px;
      overflow-y: auto;
      line-height: 1.5;
      border: 1px solid var(--border);
    }
    .approval-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--sp-sm);
    }
    .approval-btn {
      border: none;
      border-radius: var(--radius-sm);
      padding: 4px 14px;
      font-family: var(--font-family);
      font-size: 0.85em;
      cursor: pointer;
      font-weight: 500;
      transition: background var(--transition-fast);
    }
    .approval-btn-allow {
      background: var(--button-bg);
      color: var(--button-fg);
    }
    .approval-btn-allow:hover { background: var(--button-hover-bg); }
    .approval-btn-deny {
      background: var(--button-secondary-bg);
      color: var(--button-secondary-fg);
    }
    .approval-btn-deny:hover { background: var(--button-secondary-hover); }
    .approval-resolved-label {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-xs);
      font-size: 0.85em;
      font-weight: 500;
    }
    .approval-resolved-label.allowed { color: var(--success-fg); }
    .approval-resolved-label.denied { color: var(--error-fg); }

    /* ─── Error message ─── */
    .message-error {
      background: rgba(255, 68, 68, 0.08);
      border-left: 3px solid var(--error-fg);
      color: var(--error-fg);
      padding: var(--sp-sm) var(--sp-md);
      border-radius: var(--radius-sm);
      font-size: 0.88em;
      width: 100%;
      white-space: pre-wrap;
      word-wrap: break-word;
      animation: fadeIn 150ms ease both;
    }

    /* ─── Result bar ─── */
    .result-bar {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-xs) var(--sp-md);
      font-size: 0.8em;
      color: var(--description-fg);
      margin-top: 2px;
      animation: fadeIn 150ms ease both;
    }
    .result-bar .icon { width: 12px; height: 12px; color: var(--description-fg); }
    .result-bar.error .icon { color: var(--error-fg); }
    .result-bar-text { display: flex; gap: var(--sp-sm); }
    .result-bar .cost { margin-left: auto; }

    /* ─── Status indicator ─── */
    .status-indicator {
      display: none;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-sm) var(--sp-md);
      font-size: 0.85em;
      color: var(--description-fg);
      flex-shrink: 0;
    }
    .status-indicator.visible { display: flex; }
    .thinking-dots {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    .thinking-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--description-fg);
      animation: dotBounce 1.4s ease infinite both;
    }
    .thinking-dots span:nth-child(1) { animation-delay: 0s; }
    .thinking-dots span:nth-child(2) { animation-delay: 0.16s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.32s; }
    @keyframes dotBounce {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1.1); }
    }

    /* ─── Input area ─── */
    .input-area {
      border-top: 1px solid var(--border);
      padding: var(--sp-md);
      flex-shrink: 0;
      background: var(--sidebar-bg);
    }
    .input-wrapper {
      display: flex;
      gap: var(--sp-sm);
      align-items: flex-end;
    }
    .input-wrapper textarea {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-md);
      padding: var(--sp-sm) var(--sp-md);
      font-family: var(--font-family);
      font-size: var(--font-size);
      resize: none;
      min-height: 36px;
      max-height: 150px;
      line-height: 1.45;
      outline: none;
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .input-wrapper textarea::placeholder {
      color: var(--input-placeholder);
    }
    .input-wrapper textarea:focus {
      border-color: var(--focus-border);
      box-shadow: 0 0 0 1px var(--focus-border);
    }
    .send-btn {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      flex-shrink: 0;
      transition: background var(--transition-fast), transform var(--transition-fast);
    }
    .send-btn .icon { stroke: var(--button-fg); width: 15px; height: 15px; }
    .send-btn:hover { background: var(--button-hover-bg); }
    .send-btn:active { transform: scale(0.93); }
    .send-btn:disabled { opacity: 0.35; cursor: default; transform: none; }
    .send-btn.stop-btn {
      background: var(--error-fg);
    }
    .send-btn.stop-btn:hover {
      background: #e03030;
    }
    .input-hint {
      font-size: 10px;
      color: var(--description-fg);
      margin-top: 3px;
      padding-left: 2px;
    }
    .input-hint kbd {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      font-family: var(--font-family);
      font-size: 10px;
    }

    /* ─── Welcome screen ─── */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      text-align: center;
      padding: var(--sp-xl);
      gap: var(--sp-lg);
    }
    .welcome-logo {
      width: 44px;
      height: 44px;
      color: var(--button-bg);
      opacity: 0.7;
    }
    .welcome h2 {
      font-size: 1.15em;
      font-weight: 600;
      color: var(--sidebar-fg);
      opacity: 0.9;
    }
    .welcome-features {
      display: flex;
      flex-direction: column;
      gap: var(--sp-sm);
      max-width: 240px;
    }
    .welcome-feature {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      font-size: 0.85em;
      color: var(--description-fg);
      text-align: left;
    }
    .welcome-feature .icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      color: var(--description-fg);
    }
    .welcome-hint {
      font-size: 0.78em;
      color: var(--description-fg);
      opacity: 0.7;
      margin-top: var(--sp-xs);
    }
    .welcome-hint kbd {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      font-family: var(--font-family);
      font-size: 10px;
    }

    /* ─── Scrollbar ─── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--scrollbar-bg);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--scrollbar-hover);
    }
  </style>
</head>
<body>
  <!-- ─── SVG Sprite ─── -->
  <svg xmlns="http://www.w3.org/2000/svg" style="display:none">
    <symbol id="icon-send" viewBox="0 0 24 24"><path d="M12 19V5m0 0l-6 6m6-6l6 6"/></symbol>
    <symbol id="icon-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></symbol>
    <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14m-7-7h14"/></symbol>
    <symbol id="icon-user" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></symbol>
    <symbol id="icon-bot" viewBox="0 0 24 24"><path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z"/></symbol>
    <symbol id="icon-tool" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></symbol>
    <symbol id="icon-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
    <symbol id="icon-x" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></symbol>
    <symbol id="icon-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></symbol>
    <symbol id="icon-warning" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4m0 4h.01"/></symbol>
    <symbol id="icon-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></symbol>
    <symbol id="icon-terminal" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></symbol>
    <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
    <symbol id="icon-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></symbol>
    <symbol id="icon-chat" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></symbol>
    <symbol id="icon-edit" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></symbol>
  </svg>

  <!-- ─── Header ─── -->
  <div class="header">
    <span class="header-title">Neusis Code</span>
    <span class="model-badge" id="modelBadge"></span>
    <span class="header-spacer"></span>
    <div class="header-actions">
      <select class="mode-select" id="modeSelect" title="Permission mode">
        <option value="askFirst">Ask First</option>
        <option value="autoEdit" selected>Auto Edit</option>
        <option value="planFirst">Plan First</option>
      </select>
      <button class="icon-btn" id="newChatBtn" title="New Chat">
        <svg class="icon"><use href="#icon-plus"/></svg>
      </button>
    </div>
  </div>

  <!-- ─── Messages ─── -->
  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <svg class="welcome-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        <path d="M8 10h.01M12 10h.01M16 10h.01"/>
      </svg>
      <h2>Neusis Code</h2>
      <div class="welcome-features">
        <div class="welcome-feature">
          <svg class="icon"><use href="#icon-search"/></svg>
          <span>Ask questions about your code</span>
        </div>
        <div class="welcome-feature">
          <svg class="icon"><use href="#icon-edit"/></svg>
          <span>Edit files with AI assistance</span>
        </div>
        <div class="welcome-feature">
          <svg class="icon"><use href="#icon-terminal"/></svg>
          <span>Run commands in your workspace</span>
        </div>
      </div>
      <div class="welcome-hint"><kbd>Enter</kbd> to send &middot; <kbd>Shift+Enter</kbd> for newline</div>
    </div>
  </div>

  <!-- ─── Status ─── -->
  <div class="status-indicator" id="statusBar">
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
    <span id="statusText">Thinking...</span>
  </div>

  <!-- ─── Input ─── -->
  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        id="userInput"
        placeholder="Message Neusis Code..."
        rows="1"
      ></textarea>
      <button class="send-btn" id="sendBtn" title="Send">
        <svg class="icon"><use href="#icon-send"/></svg>
      </button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const welcomeEl = document.getElementById('welcome');
    const userInput = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const modeSelect = document.getElementById('modeSelect');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    const modelBadge = document.getElementById('modelBadge');

    let state = 'idle';
    let currentStreamEl = null;
    let currentStreamRow = null;
    let streamBuffer = '';
    let hasReceivedStreamText = false;

    /* ─── SVG helper ─── */
    function svgIcon(id, cls) {
      return '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#' + id + '"/></svg>';
    }

    /* ─── Tool icon mapping ─── */
    function getToolIconId(name) {
      const fileTools = ['Read', 'Write', 'Edit', 'NotebookEdit'];
      const searchTools = ['Grep', 'Glob'];
      const terminalTools = ['Bash'];
      if (fileTools.includes(name)) return 'icon-file';
      if (searchTools.includes(name)) return 'icon-search';
      if (terminalTools.includes(name)) return 'icon-terminal';
      return 'icon-tool';
    }

    /* ─── Auto-resize textarea ─── */
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    });

    /* ─── Keyboard handling ─── */
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    sendBtn.addEventListener('click', () => {
      if (state === 'streaming' || state === 'waiting') {
        vscode.postMessage({ type: 'stopGeneration' });
      } else {
        handleSend();
      }
    });

    newChatBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newChat' });
    });

    modeSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'modeChange', mode: modeSelect.value });
    });

    function handleSend() {
      const text = userInput.value.trim();
      if (!text || state === 'waiting' || state === 'streaming') return;
      addUserMessage(text);
      vscode.postMessage({ type: 'sendMessage', text });
      userInput.value = '';
      userInput.style.height = 'auto';
    }

    function addUserMessage(text) {
      hideWelcome();
      const row = document.createElement('div');
      row.className = 'msg-row-user';
      row.innerHTML =
        '<div class="message message-user">' + escapeHtml(text) + '</div>' +
        '<div class="avatar">' + svgIcon('icon-user') + '</div>';
      messagesEl.appendChild(row);
      scrollToBottom();
    }

    function hideWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'none';
    }

    function scrollToBottom() {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    /* ─── Markdown renderer ─── */
    function renderMarkdown(text) {
      // Step 1: Extract code blocks
      const codeBlocks = [];
      let processed = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push('<pre><code>' + escapeHtml(code.trim()) + '</code></pre>');
        return '\\n%%CODEBLOCK_' + idx + '%%\\n';
      });

      // Step 2: Extract inline code
      const inlineCodes = [];
      processed = processed.replace(/\`([^\`]+)\`/g, (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
        return '%%INLINE_' + idx + '%%';
      });

      // Step 3: Escape HTML in remaining text
      processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Step 4: Process block-level elements
      const lines = processed.split('\\n');
      let html = '';
      let inUl = false;
      let inOl = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Code block placeholder
        const cbMatch = trimmed.match(/^%%CODEBLOCK_(\\d+)%%$/);
        if (cbMatch) {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
          html += codeBlocks[parseInt(cbMatch[1])];
          continue;
        }

        // Horizontal rule
        if (/^---+$/.test(trimmed) || /^\\*\\*\\*+$/.test(trimmed)) {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
          html += '<hr/>';
          continue;
        }

        // Headings
        const headingMatch = trimmed.match(/^(#{1,3})\\s+(.+)$/);
        if (headingMatch) {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
          const level = headingMatch[1].length + 2; // h3, h4, h5
          html += '<h' + level + '>' + processInline(headingMatch[2]) + '</h' + level + '>';
          continue;
        }

        // Blockquote
        if (trimmed.startsWith('&gt; ') || trimmed === '&gt;') {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
          const quoteText = trimmed.replace(/^&gt;\\s?/, '');
          html += '<blockquote>' + processInline(quoteText) + '</blockquote>';
          continue;
        }

        // Unordered list
        const ulMatch = trimmed.match(/^[-*]\\s+(.+)$/);
        if (ulMatch) {
          if (inOl) { html += '</ol>'; inOl = false; }
          if (!inUl) { html += '<ul>'; inUl = true; }
          html += '<li>' + processInline(ulMatch[1]) + '</li>';
          continue;
        }

        // Ordered list
        const olMatch = trimmed.match(/^\\d+\\.\\s+(.+)$/);
        if (olMatch) {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (!inOl) { html += '<ol>'; inOl = true; }
          html += '<li>' + processInline(olMatch[1]) + '</li>';
          continue;
        }

        // Empty line — close lists, skip
        if (trimmed === '') {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
          continue;
        }

        // Regular paragraph
        if (inUl) { html += '</ul>'; inUl = false; }
        if (inOl) { html += '</ol>'; inOl = false; }
        html += '<p>' + processInline(trimmed) + '</p>';
      }
      if (inUl) html += '</ul>';
      if (inOl) html += '</ol>';

      // Step 5: Restore inline codes
      for (let i = 0; i < inlineCodes.length; i++) {
        html = html.replace('%%INLINE_' + i + '%%', inlineCodes[i]);
      }

      return html;

      function processInline(str) {
        // Bold
        str = str.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        // Italic (bold already stripped, so remaining * pairs are italic)
        str = str.replace(/\\*([^*]+?)\\*/g, '<em>$1</em>');
        // Links
        str = str.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
        return str;
      }
    }

    function ensureStreamElement() {
      if (!currentStreamEl) {
        hideWelcome();
        currentStreamRow = document.createElement('div');
        currentStreamRow.className = 'msg-row-assistant';
        currentStreamRow.innerHTML =
          '<div class="avatar">' + svgIcon('icon-bot') + '</div>';
        currentStreamEl = document.createElement('div');
        currentStreamEl.className = 'message message-assistant';
        currentStreamRow.appendChild(currentStreamEl);
        messagesEl.appendChild(currentStreamRow);
        streamBuffer = '';
      }
      return currentStreamEl;
    }

    /* ─── Collapsible tool card ─── */
    function toggleToolCard(toolId) {
      const body = document.getElementById('tool-body-' + toolId);
      const chevron = document.getElementById('tool-chevron-' + toolId);
      if (!body) return;
      if (body.classList.contains('expanded')) {
        body.classList.remove('expanded');
        if (chevron) chevron.classList.remove('rotated');
      } else {
        body.classList.add('expanded');
        if (chevron) chevron.classList.add('rotated');
      }
    }

    /* ─── Message handling ─── */
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'streamText': {
          hasReceivedStreamText = true;
          const el = ensureStreamElement();
          streamBuffer += msg.text;
          el.innerHTML = renderMarkdown(streamBuffer);
          scrollToBottom();
          break;
        }

        case 'assistantMessage': {
          if (!hasReceivedStreamText && msg.content) {
            hideWelcome();
            const text = msg.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('');
            if (text) {
              const row = document.createElement('div');
              row.className = 'msg-row-assistant';
              row.innerHTML = '<div class="avatar">' + svgIcon('icon-bot') + '</div>';
              const el = document.createElement('div');
              el.className = 'message message-assistant';
              el.innerHTML = renderMarkdown(text);
              row.appendChild(el);
              messagesEl.appendChild(row);
              scrollToBottom();
            }
          }
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          hasReceivedStreamText = false;
          break;
        }

        case 'toolUseStart': {
          hideWelcome();
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          const card = document.createElement('div');
          card.className = 'tool-card';
          card.id = 'tool-' + msg.id;

          const summary = msg.summary ? escapeHtml(msg.summary) : '';
          const iconId = getToolIconId(msg.name);

          card.innerHTML =
            '<div class="tool-card-header">' +
              '<span class="tool-card-icon">' + svgIcon(iconId, 'icon-sm') + '</span>' +
              '<span class="tool-card-name">' + escapeHtml(msg.name) + '</span>' +
              '<span class="tool-card-summary">' + summary + '</span>' +
              '<span class="tool-card-status"><span class="status-dot"></span></span>' +
              '<span class="tool-card-chevron" id="tool-chevron-' + msg.id + '">' + svgIcon('icon-chevron', 'icon-sm') + '</span>' +
            '</div>' +
            '<div class="tool-card-body" id="tool-body-' + msg.id + '">' +
              '<div class="tool-card-body-inner" id="tool-content-' + msg.id + '"></div>' +
            '</div>';
          card.querySelector('.tool-card-header').addEventListener('click', () => {
            toggleToolCard(msg.id);
          });
          messagesEl.appendChild(card);
          scrollToBottom();
          break;
        }

        case 'toolResult': {
          const card = document.getElementById('tool-' + msg.toolUseId);
          if (card) {
            const statusEl = card.querySelector('.tool-card-status');
            if (statusEl) {
              if (msg.isError) {
                statusEl.innerHTML = svgIcon('icon-x', 'icon-sm status-error');
              } else {
                statusEl.innerHTML = svgIcon('icon-check', 'icon-sm status-done');
              }
            }
            // Put content in the collapsible body
            if (msg.content) {
              const contentEl = document.getElementById('tool-content-' + msg.toolUseId);
              if (contentEl) {
                const truncated = msg.content.length > 800
                  ? msg.content.substring(0, 800) + '\\n...'
                  : msg.content;
                contentEl.textContent = truncated;
              }
            }
          }
          scrollToBottom();
          break;
        }

        case 'resultMessage': {
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          if (msg.isError && msg.result) {
            const errMsg = document.createElement('div');
            errMsg.className = 'message message-error';
            errMsg.textContent = msg.result;
            messagesEl.appendChild(errMsg);
          }
          const bar = document.createElement('div');
          bar.className = 'result-bar' + (msg.isError ? ' error' : '');
          const durationSec = (msg.duration / 1000).toFixed(1);
          const costStr = msg.cost > 0 ? '$' + msg.cost.toFixed(4) : '';
          bar.innerHTML =
            svgIcon('icon-info', 'icon-sm') +
            '<span class="result-bar-text">' +
              '<span>' + (msg.isError ? 'Error' : 'Done') + '</span>' +
              '<span>&middot;</span>' +
              '<span>' + durationSec + 's</span>' +
            '</span>' +
            (costStr ? '<span class="cost">' + costStr + '</span>' : '');
          messagesEl.appendChild(bar);
          scrollToBottom();
          break;
        }

        case 'errorMessage': {
          hideWelcome();
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          const errEl = document.createElement('div');
          errEl.className = 'message message-error';
          errEl.textContent = msg.message;
          messagesEl.appendChild(errEl);
          scrollToBottom();
          break;
        }

        case 'approvalRequest': {
          hideWelcome();
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          const aCard = document.createElement('div');
          aCard.className = 'approval-card';
          aCard.id = 'approval-' + msg.requestId;

          const aHeader = document.createElement('div');
          aHeader.className = 'approval-header';
          aHeader.innerHTML =
            '<span class="approval-icon">' + svgIcon('icon-warning', 'icon-sm') + '</span>' +
            '<span>Claude wants to use: </span>' +
            '<span class="approval-tool-name">' + escapeHtml(msg.toolName) + '</span>';
          aCard.appendChild(aHeader);

          const detail = document.createElement('div');
          detail.className = 'approval-detail';
          detail.textContent = msg.detail;
          aCard.appendChild(detail);

          const actions = document.createElement('div');
          actions.className = 'approval-actions';

          const denyBtnEl = document.createElement('button');
          denyBtnEl.className = 'approval-btn approval-btn-deny';
          denyBtnEl.textContent = 'Deny';
          denyBtnEl.addEventListener('click', () => {
            resolveApproval(msg.requestId, false, aCard);
          });

          const allowBtnEl = document.createElement('button');
          allowBtnEl.className = 'approval-btn approval-btn-allow';
          allowBtnEl.textContent = 'Allow';
          allowBtnEl.addEventListener('click', () => {
            resolveApproval(msg.requestId, true, aCard);
          });

          actions.appendChild(denyBtnEl);
          actions.appendChild(allowBtnEl);
          aCard.appendChild(actions);

          messagesEl.appendChild(aCard);
          scrollToBottom();
          break;
        }

        case 'sessionInit': {
          if (msg.model) {
            const shortModel = msg.model.replace('claude-', '').split('-202')[0];
            modelBadge.textContent = shortModel;
            modelBadge.classList.add('visible');
          }
          break;
        }

        case 'modeSync': {
          modeSelect.value = msg.mode;
          break;
        }

        case 'stateChange': {
          state = msg.state;
          updateUI();
          break;
        }

        case 'clear': {
          messagesEl.innerHTML = '';
          if (welcomeEl) {
            messagesEl.appendChild(welcomeEl);
            welcomeEl.style.display = '';
          }
          currentStreamEl = null;
          currentStreamRow = null;
          streamBuffer = '';
          hasReceivedStreamText = false;
          modelBadge.classList.remove('visible');
          modelBadge.textContent = '';
          break;
        }
      }
    });

    function resolveApproval(requestId, approved, cardEl) {
      vscode.postMessage({ type: 'approvalResponse', requestId, approved });
      cardEl.classList.add('resolved');
      const header = cardEl.querySelector('.approval-header');
      const toolName = header ? (header.querySelector('.approval-tool-name')?.textContent || '') : '';
      const label = approved ? 'Allowed' : 'Denied';
      const labelClass = approved ? 'allowed' : 'denied';
      const iconId = approved ? 'icon-check' : 'icon-x';
      cardEl.innerHTML =
        '<div class="approval-header">' +
          '<span class="approval-icon">' + svgIcon('icon-warning', 'icon-sm') + '</span>' +
          '<span class="approval-tool-name">' + escapeHtml(toolName) + '</span>' +
          '<span class="approval-resolved-label ' + labelClass + '">&mdash; ' + label + ' ' + svgIcon(iconId, 'icon-sm') + '</span>' +
        '</div>';
      scrollToBottom();
    }

    function updateUI() {
      if (state === 'waiting') {
        statusBar.classList.add('visible');
        statusText.textContent = 'Thinking...';
        sendBtn.innerHTML = svgIcon('icon-stop');
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = true;
      } else if (state === 'streaming') {
        statusBar.classList.add('visible');
        statusText.textContent = 'Generating...';
        sendBtn.innerHTML = svgIcon('icon-stop');
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = true;
      } else if (state === 'error') {
        statusBar.classList.remove('visible');
        sendBtn.innerHTML = svgIcon('icon-send');
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = false;
        userInput.focus();
      } else {
        statusBar.classList.remove('visible');
        sendBtn.innerHTML = svgIcon('icon-send');
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = false;
        userInput.focus();
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    userInput.focus();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
