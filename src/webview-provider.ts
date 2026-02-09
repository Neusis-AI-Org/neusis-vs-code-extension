import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ClaudeProcess } from './claude-process';
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
  private approvalServer: ApprovalServer | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private approvalCounter = 0;
  private hookDir: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.claudeProcess = new ClaudeProcess();
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
      this.cleanupApprovalSetup();
    });
  }

  public newChat(): void {
    this.claudeProcess.stop();
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
          this.postMessage({
            type: 'toolUseStart',
            id: event.content_block.id,
            name: event.content_block.name,
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
      --font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover-bg: var(--vscode-button-hoverBackground);
      --border: var(--vscode-panel-border, var(--vscode-widget-border, #333));
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --link-fg: var(--vscode-textLink-foreground);
      --code-bg: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
      --user-msg-bg: var(--vscode-button-background);
      --user-msg-fg: var(--vscode-button-foreground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      font-family: var(--font-family);
      font-size: var(--font-size);
      background: var(--bg);
      color: var(--fg);
    }

    body {
      display: flex;
      flex-direction: column;
    }

    /* ─── Header ─── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .header-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .header-actions {
      display: flex;
      gap: 4px;
    }
    .header-btn {
      background: none;
      border: none;
      color: var(--fg);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 14px;
      opacity: 0.7;
      line-height: 1;
    }
    .header-btn:hover {
      opacity: 1;
      background: rgba(255,255,255,0.08);
    }

    /* ─── Mode selector ─── */
    .mode-select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 2px 4px;
      font-family: var(--font-family);
      font-size: 11px;
      cursor: pointer;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
      padding-right: 16px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath fill='%23888' d='M0 2l4 4 4-4z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 4px center;
    }
    .mode-select:focus {
      border-color: var(--vscode-focusBorder, var(--button-bg));
    }

    /* ─── Messages area ─── */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      max-width: 100%;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .message-user {
      align-self: flex-end;
      background: var(--user-msg-bg);
      color: var(--user-msg-fg);
      padding: 8px 12px;
      border-radius: 12px 12px 2px 12px;
      max-width: 85%;
    }

    .message-assistant {
      align-self: flex-start;
      padding: 4px 0;
      width: 100%;
    }

    .message-assistant p { margin: 4px 0; }
    .message-assistant code {
      background: var(--code-bg);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 0.92em;
    }
    .message-assistant pre {
      background: var(--code-bg);
      padding: 10px 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 6px 0;
      font-size: 0.92em;
    }
    .message-assistant pre code {
      background: none;
      padding: 0;
    }

    /* ─── Tool use ─── */
    .tool-use {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--code-bg);
      border-radius: 6px;
      border-left: 3px solid var(--badge-bg);
      font-size: 0.9em;
      margin: 4px 0;
    }
    .tool-use .tool-icon { opacity: 0.7; }
    .tool-use .tool-name {
      font-weight: 600;
      color: var(--link-fg);
    }
    .tool-use .tool-status {
      margin-left: auto;
      font-size: 0.85em;
      opacity: 0.6;
    }
    .tool-result-content {
      max-height: 120px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      padding: 6px 10px;
      background: var(--code-bg);
      border-radius: 0 0 6px 6px;
      margin-top: -4px;
      margin-bottom: 4px;
      white-space: pre-wrap;
      opacity: 0.8;
    }

    /* ─── Approval card ─── */
    .approval-card {
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 6px;
      padding: 10px 12px;
      margin: 4px 0;
      background: var(--code-bg);
    }
    .approval-card.resolved {
      opacity: 0.7;
    }
    .approval-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.9em;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .approval-header .approval-icon {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .approval-header .approval-tool-name {
      color: var(--link-fg);
    }
    .approval-detail {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      background: rgba(0,0,0,0.15);
      border-radius: 4px;
      padding: 8px 10px;
      margin-bottom: 10px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.4;
    }
    .approval-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .approval-btn {
      border: none;
      border-radius: 4px;
      padding: 5px 14px;
      font-family: var(--font-family);
      font-size: 0.85em;
      cursor: pointer;
      font-weight: 500;
    }
    .approval-btn-allow {
      background: var(--button-bg);
      color: var(--button-fg);
    }
    .approval-btn-allow:hover {
      background: var(--button-hover-bg);
    }
    .approval-btn-deny {
      background: rgba(255,255,255,0.08);
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .approval-btn-deny:hover {
      background: rgba(255,255,255,0.14);
    }
    .approval-resolved-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .approval-resolved-label.allowed {
      color: var(--vscode-testing-iconPassed, #73c991);
    }
    .approval-resolved-label.denied {
      color: var(--vscode-errorForeground, #f44);
    }

    /* ─── Error message ─── */
    .message-error {
      align-self: flex-start;
      background: rgba(255, 68, 68, 0.1);
      border-left: 3px solid var(--vscode-errorForeground, #f44);
      color: var(--vscode-errorForeground, #f44);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 0.9em;
      width: 100%;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    /* ─── Result bar ─── */
    .result-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: var(--code-bg);
      border-radius: 6px;
      font-size: 0.85em;
      opacity: 0.7;
      margin-top: 4px;
    }
    .result-bar.error {
      border-left: 3px solid var(--vscode-errorForeground, #f44);
    }

    /* ─── Status ─── */
    .status-indicator {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      font-size: 0.9em;
      opacity: 0.8;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .status-indicator.visible { display: flex; }
    .spinner {
      width: 14px; height: 14px;
      border: 2px solid var(--fg);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ─── Input area ─── */
    .input-area {
      border-top: 1px solid var(--border);
      padding: 10px 12px;
      flex-shrink: 0;
    }
    .input-wrapper {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .input-wrapper textarea {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: var(--font-family);
      font-size: var(--font-size);
      resize: none;
      min-height: 38px;
      max-height: 150px;
      line-height: 1.4;
      outline: none;
    }
    .input-wrapper textarea:focus {
      border-color: var(--vscode-focusBorder, var(--button-bg));
    }
    .send-btn {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 14px;
      flex-shrink: 0;
      line-height: 1;
      height: 38px;
    }
    .send-btn:hover { background: var(--button-hover-bg); }
    .send-btn:disabled { opacity: 0.4; cursor: default; }
    .stop-btn {
      background: var(--vscode-errorForeground, #f44);
      color: #fff;
    }

    /* ─── Welcome ─── */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      text-align: center;
      padding: 24px;
      opacity: 0.6;
      gap: 8px;
    }
    .welcome-icon { font-size: 32px; margin-bottom: 4px; }
    .welcome h2 { font-size: 1.1em; font-weight: 600; }
    .welcome p { font-size: 0.9em; max-width: 280px; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.15);
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-title">Neusis Code</span>
    <div class="header-actions">
      <select class="mode-select" id="modeSelect" title="Permission mode">
        <option value="askFirst">Ask First</option>
        <option value="autoEdit">Auto Edit</option>
        <option value="planFirst">Plan First</option>
      </select>
      <button class="header-btn" id="newChatBtn" title="New Chat">+</button>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">&#x2728;</div>
      <h2>Neusis Code</h2>
      <p>Ask Claude anything about your codebase. Messages are sent to the Claude Code CLI.</p>
    </div>
  </div>

  <div class="status-indicator" id="statusBar">
    <div class="spinner"></div>
    <span id="statusText">Thinking...</span>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        id="userInput"
        placeholder="Ask Claude..."
        rows="1"
      ></textarea>
      <button class="send-btn" id="sendBtn" title="Send">&#x27A4;</button>
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

    let state = 'idle'; // idle | waiting | streaming
    let currentStreamEl = null;
    let streamBuffer = '';
    let hasReceivedStreamText = false;

    // ─── Auto-resize textarea ───
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    });

    // ─── Send on Enter (Shift+Enter for newline) ───
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
      const el = document.createElement('div');
      el.className = 'message message-user';
      el.textContent = text;
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function hideWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ─── Simple markdown rendering ───
    function renderMarkdown(text) {
      let html = text
        // Escape HTML
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Code blocks
      html = html.replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        return '<pre><code>' + code.trim() + '</code></pre>';
      });

      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

      // Line breaks into paragraphs
      html = html
        .split(/\\n\\n+/)
        .map(p => '<p>' + p.replace(/\\n/g, '<br/>') + '</p>')
        .join('');

      return html;
    }

    function ensureStreamElement() {
      if (!currentStreamEl) {
        hideWelcome();
        currentStreamEl = document.createElement('div');
        currentStreamEl.className = 'message message-assistant';
        messagesEl.appendChild(currentStreamEl);
        streamBuffer = '';
      }
      return currentStreamEl;
    }

    // ─── Message handling from extension ───
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
          // If streaming didn't produce any text, render the full message content
          if (!hasReceivedStreamText && msg.content) {
            hideWelcome();
            const text = msg.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('');
            if (text) {
              const el = document.createElement('div');
              el.className = 'message message-assistant';
              el.innerHTML = renderMarkdown(text);
              messagesEl.appendChild(el);
              scrollToBottom();
            }
          }
          currentStreamEl = null;
          streamBuffer = '';
          hasReceivedStreamText = false;
          break;
        }

        case 'toolUseStart': {
          hideWelcome();
          currentStreamEl = null;
          streamBuffer = '';
          const toolEl = document.createElement('div');
          toolEl.className = 'tool-use';
          toolEl.id = 'tool-' + msg.id;
          toolEl.innerHTML =
            '<span class="tool-icon">&#x2699;</span>' +
            '<span class="tool-name">' + escapeHtml(msg.name) + '</span>' +
            '<span class="tool-status">running...</span>';
          messagesEl.appendChild(toolEl);
          scrollToBottom();
          break;
        }

        case 'toolResult': {
          const toolEl = document.getElementById('tool-' + msg.toolUseId);
          if (toolEl) {
            const statusSpan = toolEl.querySelector('.tool-status');
            if (statusSpan) {
              statusSpan.textContent = msg.isError ? 'error' : 'done';
            }
          }
          // Show truncated result content
          if (msg.content) {
            const resultEl = document.createElement('div');
            resultEl.className = 'tool-result-content';
            const truncated = msg.content.length > 500
              ? msg.content.substring(0, 500) + '...'
              : msg.content;
            resultEl.textContent = truncated;
            messagesEl.appendChild(resultEl);
            scrollToBottom();
          }
          break;
        }

        case 'resultMessage': {
          currentStreamEl = null;
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
            '<span>' + (msg.isError ? 'Error' : 'Done') + ' &middot; ' + durationSec + 's</span>' +
            '<span>' + costStr + '</span>';
          messagesEl.appendChild(bar);
          scrollToBottom();
          break;
        }

        case 'errorMessage': {
          hideWelcome();
          currentStreamEl = null;
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
          streamBuffer = '';
          const card = document.createElement('div');
          card.className = 'approval-card';
          card.id = 'approval-' + msg.requestId;

          const header = document.createElement('div');
          header.className = 'approval-header';
          header.innerHTML =
            '<span class="approval-icon">&#x26A0;</span>' +
            '<span>Claude wants to use: </span>' +
            '<span class="approval-tool-name">' + escapeHtml(msg.toolName) + '</span>';
          card.appendChild(header);

          const detail = document.createElement('div');
          detail.className = 'approval-detail';
          detail.textContent = msg.detail;
          card.appendChild(detail);

          const actions = document.createElement('div');
          actions.className = 'approval-actions';

          const denyBtn = document.createElement('button');
          denyBtn.className = 'approval-btn approval-btn-deny';
          denyBtn.textContent = 'Deny';
          denyBtn.addEventListener('click', () => {
            resolveApproval(msg.requestId, false, card);
          });

          const allowBtn = document.createElement('button');
          allowBtn.className = 'approval-btn approval-btn-allow';
          allowBtn.textContent = 'Allow';
          allowBtn.addEventListener('click', () => {
            resolveApproval(msg.requestId, true, card);
          });

          actions.appendChild(denyBtn);
          actions.appendChild(allowBtn);
          card.appendChild(actions);

          messagesEl.appendChild(card);
          scrollToBottom();
          break;
        }

        case 'sessionInit': {
          // Could show model info in header
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
          streamBuffer = '';
          hasReceivedStreamText = false;
          break;
        }
      }
    });

    function resolveApproval(requestId, approved, cardEl) {
      vscode.postMessage({ type: 'approvalResponse', requestId, approved });
      // Replace the card content with a resolved summary
      cardEl.classList.add('resolved');
      const header = cardEl.querySelector('.approval-header');
      const toolName = header ? header.querySelector('.approval-tool-name')?.textContent || '' : '';
      const label = approved ? 'Allowed' : 'Denied';
      const labelClass = approved ? 'allowed' : 'denied';
      const icon = approved ? '&#x2713;' : '&#x2717;';
      cardEl.innerHTML =
        '<div class="approval-header">' +
          '<span class="approval-icon">&#x26A0;</span>' +
          '<span class="approval-tool-name">' + escapeHtml(toolName) + '</span>' +
          '<span class="approval-resolved-label ' + labelClass + '">&mdash; ' + label + ' ' + icon + '</span>' +
        '</div>';
      scrollToBottom();
    }

    function updateUI() {
      if (state === 'waiting') {
        statusBar.classList.add('visible');
        statusText.textContent = 'Thinking...';
        sendBtn.innerHTML = '&#x25A0;';
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = true;
      } else if (state === 'streaming') {
        statusBar.classList.add('visible');
        statusText.textContent = 'Generating...';
        sendBtn.innerHTML = '&#x25A0;';
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = true;
      } else if (state === 'error') {
        statusBar.classList.remove('visible');
        sendBtn.innerHTML = '&#x27A4;';
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = false;
        userInput.focus();
      } else {
        statusBar.classList.remove('visible');
        sendBtn.innerHTML = '&#x27A4;';
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = false;
        userInput.disabled = false;
        userInput.focus();
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Focus input on load
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
