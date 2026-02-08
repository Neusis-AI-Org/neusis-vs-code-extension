# Project Guidelines — Neusis Code (VS Code Extension)

## Architecture

Three-layer architecture: **Webview ↔ WebviewProvider (mediator) ↔ ClaudeProcess (child process)**.

- [src/extension.ts](src/extension.ts) — Activation, command registration, provider setup
- [src/webview-provider.ts](src/webview-provider.ts) — `NeusisChatViewProvider` mediates between the inline webview UI and `ClaudeProcess`; all HTML/CSS/JS lives in `getHtmlForWebview()` as a single template literal (no separate webview build)
- [src/claude-process.ts](src/claude-process.ts) — Spawns `claude` CLI in streaming NDJSON mode over stdio; extends `EventEmitter` with typed events (`system`, `assistant`, `streamEvent`, `result`, `error`, `exit`)
- [src/types.ts](src/types.ts) — All shared types: discriminated unions keyed on `type` for `ClaudeMessage`, `ExtensionToWebviewMessage`, `WebviewToExtensionMessage`

State flow: `idle → waiting → streaming → idle | error`, broadcast to webview via `stateChange` messages.

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
- **Error handling**: Use `vscode.window.showErrorMessage()` for user-critical errors; route process errors to webview as `errorMessage` type. Silent `try/catch` for NDJSON parse failures on non-JSON lines.
- **Content Security Policy**: Webview uses a nonce-based CSP — preserve this when modifying inline scripts.
- **Theming**: Webview uses `--vscode-*` CSS variables for full theme integration.

## Integration Points

- **Claude CLI**: Must be installed and on PATH. Invoked as `claude -p --input-format stream-json --output-format stream-json --verbose` with `shell: true` and workspace folder as `cwd`.
- **VS Code API**: Extension contributes an Activity Bar container (`neusis-code`), a webview view (`neusis-code.chatView`), and two commands (`neusis-code.newChat`, `neusis-code.stopGeneration`). Activation: `onView:neusis-code.chatView`.
