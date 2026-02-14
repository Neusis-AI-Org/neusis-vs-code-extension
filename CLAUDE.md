# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Neusis Code (package name: `openchamber`) is a VS Code extension that embeds an AI chat UI in the activity bar and connects to the [OpenCode](https://opencode.ai) API. It's a Bun-based monorepo with workspaces.

## Build & Development Commands

```bash
bun install                    # Install dependencies
bun run build                  # Build extension + webview
bun run build:extension        # esbuild bundle → dist/extension.js
bun run build:webview           # Vite build → dist/webview/
bun run dev                    # Watch mode (extension + webview concurrently)
bun run type-check             # TypeScript validation (both tsconfigs)
bun run lint                   # ESLint on src/ and webview/
bun run package                # vsce package (produces .vsix)
```

To test: open the repo in VS Code, press F5 to launch the Extension Development Host.

## Architecture

### Two-Process Model

The extension runs in two separate contexts that communicate via `postMessage`:

1. **Extension Host** (Node.js) — `src/` directory
   - Entry point: `src/extension.ts` → `activate()` registers providers, commands, and watchers
   - **Bridge** (`src/bridge.ts`): Central message dispatcher handling all webview↔extension communication (API proxying, SSE streaming, VS Code commands, theme sync, connection status)
   - **OpenCode Manager** (`src/opencode.ts`): Manages the local OpenCode CLI process — auto-starts if no external `apiUrl` is configured; workspace-isolated (each workspace gets its own instance)
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
- `assets/` — Extension icons

## Configuration

All VS Code settings use the `openchamber.*` prefix:
- `openchamber.apiUrl` — External OpenCode API URL (empty = auto-start local)
- `openchamber.opencodeBinary` — Path to opencode CLI
- `openchamber.claudeCodeBinary` — Path to Claude Code CLI

All VS Code commands use the `openchamber.*` prefix (e.g., `openchamber.focusChat`, `openchamber.restartApi`).

## TypeScript Configuration

Two separate tsconfig files:
- `tsconfig.json` — Extension host code (`src/`)
- `tsconfig.webview.json` — Webview code (`packages/ui/`, `webview/`)

Both use strict mode with no-emit (type-check only). Bundling is handled by esbuild (extension) and Vite (webview).

## Path Aliases

Vite resolves these aliases (defined in `vite.config.ts`):
- `@openchamber/ui` → `packages/ui/src`
- `@vscode` → `webview/api`
- `@/` → `packages/ui/src`
