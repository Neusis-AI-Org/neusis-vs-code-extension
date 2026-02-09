import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  ClaudeMessage,
  ClaudeInputMessage,
  ClaudeSystemMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeStreamEvent,
  ClaudeResultMessage,
} from './types';

export interface ClaudeProcessEvents {
  system: [msg: ClaudeSystemMessage];
  assistant: [msg: ClaudeAssistantMessage];
  user: [msg: ClaudeUserMessage];
  streamEvent: [msg: ClaudeStreamEvent];
  result: [msg: ClaudeResultMessage];
  error: [err: Error];
  exit: [code: number | null];
}

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private _sessionId = 'default';
  private _isRunning = false;

  get sessionId(): string {
    return this._sessionId;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Spawn the Claude Code CLI in streaming JSON mode.
   * @param cwd Working directory for the process
   * @param permissionMode Permission mode for tool execution
   * @param settingsPath Optional path to a settings JSON file (used for hooks)
   */
  start(cwd: string, permissionMode = 'acceptEdits', settingsPath?: string): void {
    if (this.proc) {
      this.stop();
    }

    this.buffer = '';
    this._sessionId = 'default';
    this._isRunning = true;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
    ];

    if (settingsPath) {
      args.push('--settings', settingsPath);
    }

    this.proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString('utf-8'));
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        // Claude CLI writes debug/info to stderr; only log it.
        // Genuine errors are caught by the process 'error' and 'exit' handlers.
        console.error('[ClaudeProcess stderr]', text);
      }
    });

    this.proc.on('exit', (code) => {
      this._isRunning = false;
      this.proc = null;
      this.emit('exit', code);
    });

    this.proc.on('error', (err) => {
      this._isRunning = false;
      this.emit('error', err);
    });
  }

  /**
   * Send a user message to the Claude process via stdin.
   */
  sendMessage(text: string): void {
    if (!this.proc?.stdin?.writable) {
      this.emit('error', new Error('Claude process is not running'));
      return;
    }

    const msg: ClaudeInputMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
      session_id: this._sessionId,
      parent_tool_use_id: null,
    };

    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Kill the child process.
   */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
      this._isRunning = false;
    }
  }

  /**
   * Parse newline-delimited JSON from stdout chunks.
   */
  private handleStdout(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}

      try {
        const msg = JSON.parse(trimmed) as ClaudeMessage;
        this.routeMessage(msg);
      } catch {
        // Non-JSON output, ignore
      }
    }
  }

  /**
   * Route a parsed message to the appropriate event.
   */
  private routeMessage(msg: ClaudeMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          this._sessionId = msg.session_id;
        }
        this.emit('system', msg);
        break;
      case 'assistant':
        this.emit('assistant', msg);
        break;
      case 'user':
        this.emit('user', msg);
        break;
      case 'stream_event':
        this.emit('streamEvent', msg);
        break;
      case 'result':
        this.emit('result', msg);
        break;
    }
  }
}
