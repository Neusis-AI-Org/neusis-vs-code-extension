# Project Guidelines — Neusis Code (VS Code Extension)

## Architecture

Three-layer architecture: **Webview ↔ WebviewProvider (mediator) ↔ ClaudeProcess (child process)**.

- [src/extension.ts](src/extension.ts) — Activation, command registration, provider setup
- [src/webview-provider.ts](src/webview-provider.ts) — `NeusisChatViewProvider` mediates between the inline webview UI and `ClaudeProcess`; all HTML/CSS/JS lives in `getHtmlForWebview()` as a single template literal (no separate webview build). Also manages the `ApprovalServer` and hook files for "Ask First" permission mode.
- [src/claude-process.ts](src/claude-process.ts) — Spawns `claude` CLI in streaming NDJSON mode over stdio; extends `EventEmitter` with typed events (`system`, `assistant`, `streamEvent`, `result`, `error`, `exit`). Accepts `permissionMode` and optional `settingsPath` (for hooks) on `start()`.
- [src/approval-server.ts](src/approval-server.ts) — Lightweight HTTP server on localhost for "Ask First" mode. Receives tool approval requests from the `PreToolUse` hook script and shows a VS Code modal dialog (`vscode.window.showWarningMessage`). Formats tool details (file path, command, content preview) for user review.
- [src/types.ts](src/types.ts) — All shared types: discriminated unions keyed on `type` for `ClaudeMessage`, `ExtensionToWebviewMessage`, `WebviewToExtensionMessage`, plus `PermissionMode` type.

State flow: `idle → waiting → streaming → idle | error`, broadcast to webview via `stateChange` messages.

## Permission Modes

Three user-selectable modes, configurable via the webview header dropdown or VS Code setting `neusis-code.permissionMode`:

| Mode | Setting value | CLI flags | Behavior |
|------|--------------|-----------|----------|
| **Ask First** | `askFirst` | `--permission-mode bypassPermissions --settings <hooks>` | PreToolUse hook intercepts write/edit/bash tools. Hook script POSTs to `ApprovalServer` on localhost; extension shows modal dialog. Read-only tools (Read, Glob, Grep, etc.) auto-allowed. |
| **Auto Edit** | `autoEdit` | `--permission-mode bypassPermissions` | All tools auto-approved. Default mode. |
| **Plan First** | `planFirst` | `--permission-mode plan` | Read-only — no file writes, edits, or commands. |

Changing mode mid-conversation stops the current CLI process; the next message starts a fresh session with the new permissions.

### Ask First — Hook Architecture

1. `ApprovalServer` starts an HTTP server on a random port (`127.0.0.1:0`).
2. A Node.js hook script is written to a temp directory with the port baked in.
3. A settings JSON file is written with `PreToolUse` hook config pointing to the script.
4. CLI is started with `--settings <path-to-settings.json>`.
5. On each tool use, the hook reads tool info from stdin, POSTs to the server, and outputs a `hookSpecificOutput` JSON with `permissionDecision: "allow" | "deny"`.
6. Temp files and server are cleaned up on webview dispose.

## Code Style

- **Strict TypeScript** — `tsconfig.json` has `"strict": true`
- **Discriminated unions** on `type` field for all message protocols — add new message types to the unions in [src/types.ts](src/types.ts)
- **PascalCase** for classes/interfaces, **camelCase** for members/variables, **kebab-case** for command/view IDs (`neusis-code.*`)
- Private backing fields use leading underscore (`_sessionId`) with public getters
- `* as vscode` import for VS Code API; named imports for local modules
- Zero runtime dependencies — only `claude` CLI required in PATH

## Build and Test

```bash
npm install          # Install dev dependencies
npm run compile      # Production webpack build → dist/extension.js
npm run watch        # Dev webpack watch mode
npm run lint         # ESLint
```

Webpack bundles [src/extension.ts](src/extension.ts) → `dist/extension.js` (target: `node`, externals: `vscode`). No test framework is currently configured.

## Project Conventions

- **Inline webview**: All webview HTML/CSS/JS is a template literal inside `getHtmlForWebview()` in [src/webview-provider.ts](src/webview-provider.ts). There is no separate frontend build. Edits to the UI go directly in that method.
- **NDJSON protocol**: Communication with Claude CLI uses newline-delimited JSON on stdin/stdout. Parse carefully — partial lines are buffered in `ClaudeProcess`.
- **Message routing**: Webview → extension messages are handled in `handleWebviewMessage()`; ClaudeProcess events are wired to webview via `postMessage()` in `setupProcessListeners()`.
- **Response display**: Streaming text is shown via `streamText` messages during `stream_event` deltas. The `assistantMessage` handler renders the full message content as a fallback when no stream text was received.
- **Error handling**: Use `vscode.window.showErrorMessage()` for user-critical errors; route process errors to webview as `errorMessage` type. Silent `try/catch` for NDJSON parse failures on non-JSON lines. Stderr from the CLI is logged but not surfaced as errors (the CLI writes debug info to stderr).
- **Content Security Policy**: Webview uses a nonce-based CSP — preserve this when modifying inline scripts.
- **Theming**: Webview uses `--vscode-*` CSS variables for full theme integration.

## Integration Points

- **Claude CLI**: Must be installed and on PATH. Invoked as `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode <mode>` with `shell: true` and workspace folder as `cwd`. The `--settings` flag is added when hooks are needed (Ask First mode).
- **VS Code API**: Extension contributes an Activity Bar container (`neusis-code`), a webview view (`neusis-code.chatView`), two commands (`neusis-code.newChat`, `neusis-code.stopGeneration`), and one configuration setting (`neusis-code.permissionMode`). Activation: `onView:neusis-code.chatView`.
- **CLI Permission Note**: The CLI in `-p` (pipe) mode has no interactive permission protocol over stdin/stdout. Permissions are controlled entirely via `--permission-mode` and `PreToolUse` hooks. The CLI's `stream-json` format does not send permission request messages.

