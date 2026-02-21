# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Neusis Code (package name: `openchamber`) is a VS Code extension that embeds an AI chat UI in the activity bar and connects to the [OpenCode](https://opencode.ai) API. It's a Bun-based monorepo with workspaces. Distributed via GitHub Releases — not the VS Code Marketplace.

## Build & Development Commands

```bash
bun install                    # Install dependencies
bun run build                  # Build extension + webview
bun run build:extension        # esbuild bundle → dist/extension.js
bun run build:webview          # Vite build → dist/webview/
bun run dev                    # Watch mode (extension + webview concurrently)
bun run type-check             # TypeScript validation (both tsconfigs)
bun run lint                   # ESLint on src/ and webview/
bun run package                # vsce package (produces .vsix)
```

To test: open the repo in VS Code, press F5 to launch the Extension Development Host.

> `bun run package` may exit with code 1 due to Vite's large-chunk size warnings in the prepublish step — the `.vsix` is still produced successfully. Check for the file rather than trusting the exit code.

## Branding Rules

All **user-visible** strings (notifications, error dialogs, webview UI text) must say **"Neusis Code"**. Never use "OpenCode", "OpenChamber", or "opencode" in any message shown to users. Internal `outputChannel.appendLine(...)` log lines may retain `[OpenChamber]` prefixes — those are not user-visible.

## Architecture

### Two-Process Model

The extension runs in two separate contexts that communicate via `postMessage`:

1. **Extension Host** (Node.js) — `src/` directory
   - Entry point: `src/extension.ts` → `activate()` registers providers, commands, and watchers
   - **Bridge** (`src/bridge.ts`): Central message dispatcher for all webview↔extension communication — API proxying, SSE streaming, VS Code commands, theme sync, GitHub auth, git operations, skills catalog, quota providers, and agent/command CRUD
   - **OpenCode Manager** (`src/opencode.ts`): Manages the local OpenCode CLI process — auto-starts if no external `apiUrl` is configured; workspace-isolated
   - **OpenCode Config** (`src/opencodeConfig.ts`): Reads/writes agents, commands, skills, and provider config from `~/.config/opencode/`
   - **Webview HTML** (`src/webviewHtml.ts`): Generates the HTML shell injected into every webview panel, including the loading/error state shown before React mounts
   - **Webview Providers**: `ChatViewProvider`, `ClaudeCodeViewProvider`, `SessionEditorPanelProvider`, `AgentManagerPanelProvider` — all extend VS Code's webview API

2. **Webview** (Browser/React) — `packages/ui/` + `webview/`
   - React 19 app built with Vite, styled with Tailwind CSS v4
   - `webview/main.tsx` bootstraps the app and injects VS Code runtime APIs via `window.__OPENCHAMBER_RUNTIME_APIS__`
   - `webview/api/bridge.ts` wraps `vscode.postMessage` for request/response with correlation IDs
   - State management: 30+ Zustand stores in `packages/ui/src/stores/`
   - Key stores: `useSessionStore` (sessions/messages), `useConfigStore` (models/providers), `useUIStore` (panels/modals), `useMessageStore`, `contextStore`

### Bridge Message Protocol

Messages between extension and webview use typed message objects. Key types:
- `api:proxy` — HTTP proxy to OpenCode API
- `api:session:message` — Session message handling
- `api:sse:start/stop` — Server-sent event streaming
- `vscode:command` — Execute VS Code commands from webview
- `command` — Extension→webview commands
- `themeChange`, `connectionStatus` — State sync

### Multi-Runtime Support

The UI package (`packages/ui/`) is designed to run in VS Code, desktop (Tauri), and web. Runtime APIs are abstracted via `RuntimeDescriptor` in `packages/ui/src/lib/api/types.ts` and injected at bootstrap. VS Code-specific implementations live in `webview/api/`.

## Key Directories

- `src/` — Extension host code (Node.js, CJS output)
- `packages/ui/src/` — Shared React UI components, stores, hooks, and utilities
- `webview/` — VS Code webview entry point and API bridge implementations
- `dist/` — Build output (`extension.js` + `webview/` assets)
- `scripts/` — Distribution setup scripts (`setup.sh`, `setup.ps1`) for end-user installation
- `assets/` — Extension icons

## Configuration

All VS Code settings use the `openchamber.*` prefix:
- `openchamber.apiUrl` — External OpenCode API URL (empty = auto-start local)
- `openchamber.opencodeBinary` — Path to opencode CLI

All VS Code commands use the `openchamber.*` prefix (e.g., `openchamber.focusChat`, `openchamber.restartApi`).

The opencode engine config lives at `~/.config/opencode/opencode.json` (read by `src/opencodeConfig.ts`). The binary is installed to `~/.opencode/bin/opencode` by the setup scripts.

## TypeScript Configuration

Two separate tsconfig files:
- `tsconfig.json` — Extension host code (`src/`)
- `tsconfig.webview.json` — Webview code (`packages/ui/`, `webview/`)

Both use strict mode with no-emit (type-check only). Bundling is handled by esbuild (extension) and Vite (webview). There are pre-existing `AbortSignal` type compatibility errors across several `src/` files — these are known and do not block the build.

## Path Aliases

Vite resolves these aliases (defined in `vite.config.ts`):
- `@openchamber/ui` → `packages/ui/src`
- `@vscode` → `webview/api`
- `@/` → `packages/ui/src`

## Distribution

The extension ships via GitHub Releases (`Neusis-AI-Org/neusis-vs-code-extension`) with three assets per release:
- `neusis-code-x.x.x.vsix` — the extension
- `setup.sh` — macOS/Linux installer (downloads opencode binary from `anomalyco/opencode` releases, writes provider config)
- `setup.ps1` — Windows installer (same, uses `opencode-windows-x64.zip`)

Both setup scripts support **offline installs**: place the opencode archive (`opencode-windows-x64.zip` / `opencode-linux-x64.tar.gz` / `opencode-darwin-arm64.zip` etc.) next to the script before running and it will be used instead of downloading.
