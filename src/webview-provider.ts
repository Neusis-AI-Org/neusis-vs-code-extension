import * as vscode from 'vscode';
import { ClaudeProcess } from './claude-process';
import {
  ClaudeSystemMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeStreamEvent,
  ClaudeResultMessage,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  ContentDelta,
} from './types';

export class NeusisChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'neusis-code.chatView';

  private webviewView?: vscode.WebviewView;
  private claudeProcess: ClaudeProcess;

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

    webviewView.onDidDispose(() => {
      this.claudeProcess.stop();
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
    }
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
      this.claudeProcess.start(cwd);
      this.postMessage({ type: 'stateChange', state: 'waiting' });
      // Small delay to let the process initialize before sending
      setTimeout(() => {
        this.claudeProcess.sendMessage(text);
      }, 500);
    } else {
      this.postMessage({ type: 'stateChange', state: 'waiting' });
      this.claudeProcess.sendMessage(text);
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
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');

    let state = 'idle'; // idle | waiting | streaming
    let currentStreamEl = null;
    let streamBuffer = '';

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
          const el = ensureStreamElement();
          streamBuffer += msg.text;
          el.innerHTML = renderMarkdown(streamBuffer);
          scrollToBottom();
          break;
        }

        case 'assistantMessage': {
          // Complete assistant message - finalize streaming element
          currentStreamEl = null;
          streamBuffer = '';
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

        case 'sessionInit': {
          // Could show model info in header
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
          break;
        }
      }
    });

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
