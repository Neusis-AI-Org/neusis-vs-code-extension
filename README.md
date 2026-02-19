# Neusis Code VS Code Extension

Neusis Code inside VS Code: embeds the Neusis Code chat UI in the activity bar and connects it to the [OpenCode](https://neusis.ai) API.

## Features

### Neusis Code UI

- Smart tool visualization (inline diffs, file trees, results highlighting)
- Rich permission cards with syntax-highlighted operation previews
- Per-agent permission modes (ask/allow/full) per session
- Branchable conversations: start a new session from any assistant response
- Task tracker UI with live progress and tool summaries
- Model selection UX (favorites, recents, and configurable tool output density)
- UI scaling controls (font size and spacing)

### VS Code Integration

- Chat UI in activity bar
- Session management with history
- File attachments via native VS Code file picker (10MB limit)
- Click-to-open files from tool output
- Auto-start `opencode` instance if not running
- Workspace-isolated OpenCode instances (different workspaces get unique instances)
- Adapts to VS Code's light/dark/high-contrast themes

## Commands

| Command | Description |
|---------|-------------|
| `Neusis Code: Focus on Chat View` | Focus chat panel |
| `Neusis Code: Restart API Connection` | Restart OpenCode API process |
| `Neusis Code: Show OpenCode Status` | Provide debug info useful for development or bug report |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `Neusis Code.apiUrl` | `http://localhost:47339` | OpenCode API server URL. Not required by default. Spawns its own process when not set. |


## Local Install

- After packaging: `code --install-extension packages/vscode/Neusis Code-*.vsix`
- Or in VS Code: Extensions panel → "Install from VSIX…" and select the file
