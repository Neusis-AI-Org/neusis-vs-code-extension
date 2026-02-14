import * as vscode from 'vscode';
import { ClaudeCodeManager, type ClaudeCodeEvent } from './claudeCode';
import { getThemeKindName } from './theme';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';

// ---------------------------------------------------------------------------
// Persistence types
// ---------------------------------------------------------------------------

interface PersistedToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string | null;
  error?: string | null;
}

interface PersistedTextBlock {
  type: 'text';
  text: string;
}

type PersistedBlock = PersistedTextBlock | PersistedToolBlock;

interface PersistedMessage {
  role: 'user' | 'assistant';
  content: PersistedBlock[];
}

interface PersistedState {
  conversationId: string | null;
  messages: PersistedMessage[];
}

const STATE_KEY = 'openchamber.claudeCode.state';
const MAX_PERSISTED_MESSAGES = 100;
const MAX_TOOL_TEXT_LENGTH = 500;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeCodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openchamber.claudeCodeView';

  private _view?: vscode.WebviewView;
  private _conversationId: string | null = null;
  private _claudeManager: ClaudeCodeManager;

  /** Mirror of webview message state for persistence. */
  private _messages: PersistedMessage[] = [];
  /** Buffer for the current assistant text being streamed. */
  private _currentAssistantText = '';
  /** Track tool blocks being built during streaming. */
  private _currentToolBlocks: Map<string, PersistedToolBlock> = new Map();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri
  ) {
    this._claudeManager = new ClaudeCodeManager(_context);

    // Restore persisted state into memory
    const saved = this._loadState();
    if (saved) {
      this._conversationId = saved.conversationId;
      this._messages = saved.messages;
    }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    void this.updateTheme(vscode.window.activeColorTheme.kind);

    // Send initial availability status
    const available = this._claudeManager.isAvailable();
    webviewView.webview.postMessage({
      type: 'claude:availability',
      available,
      version: available ? this._claudeManager.getVersion() : null,
    });

    // Restore persisted messages to the webview
    if (this._messages.length > 0) {
      webviewView.webview.postMessage({
        type: 'claude:restore',
        messages: this._messages,
        conversationId: this._conversationId,
      });
    }

    webviewView.webview.onDidReceiveMessage((message: { type: string; payload?: Record<string, unknown> }) => {
      switch (message.type) {
        case 'claude:send': {
          const prompt = message.payload?.prompt as string | undefined;
          if (!prompt?.trim()) return;
          this._handleSendPrompt(prompt.trim());
          break;
        }
        case 'claude:abort': {
          this._claudeManager.abort();
          this._view?.webview.postMessage({ type: 'claude:aborted' });
          break;
        }
        case 'claude:newConversation': {
          this._conversationId = null;
          this._messages = [];
          this._currentAssistantText = '';
          this._currentToolBlocks.clear();
          this._clearState();
          this._view?.webview.postMessage({ type: 'claude:conversationReset' });
          break;
        }
        case 'claude:checkAvailability': {
          const isAvailable = this._claudeManager.isAvailable();
          this._view?.webview.postMessage({
            type: 'claude:availability',
            available: isAvailable,
            version: isAvailable ? this._claudeManager.getVersion() : null,
          });
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this._claudeManager.abort();
      this._view = undefined;
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._view?.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      });
    }
  }

  public newConversation() {
    this._conversationId = null;
    this._messages = [];
    this._currentAssistantText = '';
    this._currentToolBlocks.clear();
    this._clearState();
    this._claudeManager.abort();
    if (this._view) {
      this._view.show(true);
      this._view.webview.postMessage({ type: 'claude:conversationReset' });
    }
  }

  public dispose() {
    this._claudeManager.dispose();
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private _loadState(): PersistedState | null {
    return this._context.globalState.get<PersistedState>(STATE_KEY) ?? null;
  }

  private _saveState(): void {
    const trimmed = this._messages.slice(-MAX_PERSISTED_MESSAGES);
    // Truncate large tool results/inputs for storage
    const sanitised: PersistedMessage[] = trimmed.map(m => ({
      role: m.role,
      content: m.content.map(b => {
        if (b.type === 'tool_use') {
          return {
            ...b,
            result: b.result ? b.result.slice(0, MAX_TOOL_TEXT_LENGTH) : b.result,
            error: b.error ? b.error.slice(0, MAX_TOOL_TEXT_LENGTH) : b.error,
          };
        }
        return b;
      }),
    }));
    void this._context.globalState.update(STATE_KEY, {
      conversationId: this._conversationId,
      messages: sanitised,
    } satisfies PersistedState);
  }

  private _clearState(): void {
    void this._context.globalState.update(STATE_KEY, undefined);
  }

  // ---------------------------------------------------------------------------
  // Prompt handling with message tracking
  // ---------------------------------------------------------------------------

  private _handleSendPrompt(prompt: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    // Track user message
    this._messages.push({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    });
    this._currentAssistantText = '';
    this._currentToolBlocks.clear();

    this._claudeManager.sendPrompt(prompt, {
      cwd: workspaceFolder,
      sessionId: this._conversationId ?? undefined,
      onEvent: (event: ClaudeCodeEvent) => {
        // Extract session ID from init or result events for multi-turn
        if (typeof event.session_id === 'string' && event.session_id) {
          this._conversationId = event.session_id;
        }

        // Track assistant content for persistence
        this._trackEvent(event);

        this._view?.webview.postMessage({ type: 'claude:event', data: event });
      },
      onDone: () => {
        // Finalize assistant message from tracked content
        this._finalizeAssistantMessage();
        this._saveState();
        this._view?.webview.postMessage({ type: 'claude:done' });
      },
      onError: (error: string) => {
        // Still save what we have
        this._finalizeAssistantMessage();
        this._saveState();
        this._view?.webview.postMessage({ type: 'claude:error', error });
      },
    });
  }

  private _trackEvent(event: ClaudeCodeEvent): void {
    // Track text deltas
    if (event.type === 'stream_event') {
      const evt = event.event as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      } | undefined;
      if (!evt) return;

      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
        this._currentAssistantText += evt.delta.text;
      }

      // Track tool use starts
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        const id = evt.content_block.id ?? `tool-${Date.now()}`;
        this._currentToolBlocks.set(id, {
          type: 'tool_use',
          id,
          name: evt.content_block.name ?? 'unknown',
          input: {},
        });
      }
    }

    // Track complete assistant messages (overrides streamed text)
    if (event.type === 'assistant') {
      const message = event.message as {
        content?: Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      } | undefined;
      if (message?.content) {
        let newText = '';
        const newTools = new Map<string, PersistedToolBlock>();

        for (const c of message.content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            newText += c.text;
          } else if (c.type === 'tool_use' && c.id && c.name) {
            newTools.set(c.id, {
              type: 'tool_use',
              id: c.id,
              name: c.name,
              input: c.input ?? {},
            });
          }
        }

        // Update text if present
        if (newText) {
          this._currentAssistantText = newText;
        }

        // Update tools only if new tools are present, otherwise keep existing ones (to avoid disappearing tools)
        if (newTools.size > 0) {
          this._currentToolBlocks = newTools;
        }
      }
    }

    // Track tool results
    if (event.type === 'tool_result') {
      const toolUseId = event.tool_use_id as string | undefined;
      const resultContent = event.content as string | Array<{ type?: string; text?: string }> | undefined;
      const isError = event.is_error as boolean | undefined;
      if (toolUseId && this._currentToolBlocks.has(toolUseId)) {
        const block = this._currentToolBlocks.get(toolUseId)!;
        let resultText = '';
        if (typeof resultContent === 'string') {
          resultText = resultContent;
        } else if (Array.isArray(resultContent)) {
          resultText = resultContent
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('');
        }
        if (isError) {
          block.error = resultText || 'Tool error';
        } else {
          block.result = resultText;
        }
      }
    }

    // Track result event (final text)
    if (event.type === 'result' && typeof event.result === 'string') {
      this._currentAssistantText = event.result;
    }

    // Track plain text fallback
    if (event.type === 'text' && typeof event.content === 'string') {
      this._currentAssistantText += (event.content as string) + '\n';
    }
  }

  private _finalizeAssistantMessage(): void {
    const blocks: PersistedBlock[] = [];

    if (this._currentAssistantText.trim()) {
      blocks.push({ type: 'text', text: this._currentAssistantText });
    }

    for (const tool of this._currentToolBlocks.values()) {
      blocks.push(tool);
    }

    if (blocks.length > 0) {
      this._messages.push({ role: 'assistant', content: blocks });
    }

    this._currentAssistantText = '';
    this._currentToolBlocks.clear();
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus: 'connected',
      cliAvailable: true,
      panelType: 'claudeCode',
    });
  }
}
