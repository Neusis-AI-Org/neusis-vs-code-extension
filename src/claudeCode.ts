import * as vscode from 'vscode';
import { spawn, execSync, type ChildProcess } from 'child_process';

export interface ClaudeCodeEvent {
  type: string;
  [key: string]: unknown;
}

export interface SendPromptOptions {
  cwd: string;
  sessionId?: string;
  onEvent: (event: ClaudeCodeEvent) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export class ClaudeCodeManager {
  private _process: ChildProcess | null = null;
  private _binaryPath: string | null = null;

  constructor(_context: vscode.ExtensionContext) {}

  /**
   * Resolve the claude binary path.
   * Priority: config setting → PATH lookup.
   */
  resolveBinary(): string | null {
    if (this._binaryPath) return this._binaryPath;

    const configured = vscode.workspace
      .getConfiguration('openchamber')
      .get<string>('claudeCodeBinary')
      ?.trim();
    if (configured) {
      this._binaryPath = configured;
      return this._binaryPath;
    }

    // Try PATH lookup
    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      const firstLine = result.split(/\r?\n/)[0]?.trim();
      if (firstLine) {
        this._binaryPath = firstLine;
        return this._binaryPath;
      }
    } catch {
      // not found
    }

    return null;
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  getVersion(): string | null {
    const binary = this.resolveBinary();
    if (!binary) return null;
    try {
      return execSync(`"${binary}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
      return null;
    }
  }

  sendPrompt(prompt: string, options: SendPromptOptions): void {
    const binary = this.resolveBinary();
    if (!binary) {
      options.onError('Claude Code CLI not found. Install it or set openchamber.claudeCodeBinary in settings.');
      return;
    }

    // Use bidirectional stream-json protocol (input + output) instead of --print.
    // This sends the prompt as structured JSON over stdin, which completely avoids
    // Windows cmd.exe shell escaping issues with CLI arguments.
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];
    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    // Remove CLAUDECODE env var to avoid "nested session" guard,
    // and remove CLAUDE_CODE_SSE_PORT to avoid port conflicts.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;

    // On Windows, .cmd/.bat files require shell: true for spawn to work.
    const useShell = process.platform === 'win32';

    const child = spawn(binary, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
    });

    this._process = child;

    // Send the prompt as a structured JSON user message via stdin.
    // This is the stream-json input protocol — same as the reference implementation.
    const userMessage = {
      type: 'user',
      session_id: options.sessionId ?? '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    };
    child.stdin?.write(JSON.stringify(userMessage) + '\n');

    let stderrBuffer = '';
    let stdoutBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      // Keep last incomplete line in buffer
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as ClaudeCodeEvent;

          // When we receive the result, close stdin so the process exits.
          if (event.type === 'result') {
            if (child.stdin && !child.stdin.destroyed) {
              child.stdin.end();
            }
          }

          options.onEvent(event);
        } catch {
          // Not valid JSON — could be plain text output, emit as a text event
          options.onEvent({ type: 'text', content: trimmed });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on('close', (code) => {
      // Flush remaining stdout
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim()) as ClaudeCodeEvent;
          options.onEvent(event);
        } catch {
          options.onEvent({ type: 'text', content: stdoutBuffer.trim() });
        }
      }

      this._process = null;

      if (code !== 0 && code !== null && stderrBuffer.trim()) {
        options.onError(stderrBuffer.trim());
      } else {
        options.onDone();
      }
    });

    child.on('error', (err) => {
      this._process = null;
      options.onError(err.message);
    });
  }

  abort(): void {
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }
  }

  dispose(): void {
    this.abort();
  }
}
