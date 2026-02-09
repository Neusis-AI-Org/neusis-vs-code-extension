import * as http from 'http';

export interface ToolApprovalRequest {
  toolName: string;
  toolInput: string;
}

/** Callback that handles an approval request and returns whether it was approved. */
export type ApprovalHandler = (request: ToolApprovalRequest, detail: string) => Promise<boolean>;

/**
 * Lightweight HTTP server on localhost that receives tool approval requests
 * from the PreToolUse hook script and delegates to an external handler.
 */
export class ApprovalServer {
  private server: http.Server | null = null;
  private _port = 0;

  constructor(private readonly onApproval: ApprovalHandler) {}

  get port(): number {
    return this._port;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/approve') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            this.handleApproval(body).then(approved => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ approved }));
            }).catch(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ approved: false }));
            });
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          resolve(this._port);
        } else {
          reject(new Error('Failed to start approval server'));
        }
      });

      this.server.on('error', reject);
    });
  }

  private async handleApproval(body: string): Promise<boolean> {
    let request: ToolApprovalRequest;
    try {
      request = JSON.parse(body);
    } catch {
      return false;
    }

    const detail = this.formatDetail(request);
    return this.onApproval(request, detail);
  }

  formatDetail(request: ToolApprovalRequest): string {
    try {
      const input = JSON.parse(request.toolInput);
      if (request.toolName === 'Write') {
        const preview = (input.content || '').substring(0, 300);
        return `File: ${input.file_path}\n\nContent preview:\n${preview}${input.content?.length > 300 ? '...' : ''}`;
      }
      if (request.toolName === 'Edit') {
        return `File: ${input.file_path}\n\nReplace:\n${(input.old_string || '').substring(0, 150)}\n\nWith:\n${(input.new_string || '').substring(0, 150)}`;
      }
      if (request.toolName === 'Bash') {
        return `Command: ${input.command}`;
      }
      if (request.toolName === 'NotebookEdit') {
        return `Notebook: ${input.notebook_path}`;
      }
      return JSON.stringify(input, null, 2).substring(0, 500);
    } catch {
      return request.toolInput.substring(0, 500);
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this._port = 0;
    }
  }
}
