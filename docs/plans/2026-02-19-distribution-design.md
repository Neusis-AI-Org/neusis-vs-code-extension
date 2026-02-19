# Distribution Design: Neusis Code Extension

**Date:** 2026-02-19
**Status:** Approved

## Problem

Ship `neusis-code.vsix` to end users without publishing to the VS Code Marketplace.
Constraints:
- Users must have a working AI backend (opencode CLI + LiteLLM config)
- opencode must not be exposed as a concept to end users — all branding is "Neusis Code"
- Each user has a unique API key issued out-of-band

## Decision

**Approach B: Setup script + .vsix on GitHub Releases**

The setup script installs and configures everything silently, then the user installs the `.vsix`.
No extension-native setup wizard is required.

---

## Distribution

**GitHub Releases** on the existing repo. Each tagged release ships:

```
neusis-code-x.x.x.vsix    ← VS Code extension
setup.ps1                  ← Windows installer
setup.sh                   ← macOS / Linux installer
```

Users receive a link to the release page. Instructions they see:
1. Run the setup script for their platform
2. Install the `.vsix` (one command printed at the end of the script)

---

## Setup Scripts

### User-facing behaviour (no opencode branding)

```
Neusis Code Setup
─────────────────
Downloading Neusis Code engine...  done
Enter your Neusis Code API key: sk-xxxxxx
Writing configuration...           done

Setup complete!
Install the extension with:
  code --install-extension neusis-code-1.6.8.vsix
```

### What the scripts actually do (implementation detail)

1. **Detect OS / arch** — determine correct opencode binary download URL from
   `https://github.com/sst/opencode/releases/latest`
2. **Download binary silently** — save to:
   - Unix:    `~/.opencode/bin/opencode`  (chmod +x)
   - Windows: `%USERPROFILE%\.opencode\bin\opencode.exe`

   This path is already auto-discovered by the extension (`src/opencode.ts` fallback list),
   so no VS Code setting changes are needed.
3. **Prompt for API key** — labelled "Neusis Code API key"
4. **Write `~/.opencode/opencode.json`** — with the LiteLLM provider config below,
   substituting the entered key. Overwrites any existing file.
5. **Print .vsix install command** and exit

### Config template written by script

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Neusis Code",
      "options": {
        "baseURL": "https://litellm-proxy-1074011666170.us-central1.run.app/v1",
        "apiKey": "<USER_API_KEY>"
      },
      "models": {
        "gemini-flash-lite-latest": {
          "name": "gemini-flash-lite-latest",
          "maxTokens": "200000"
        }
      }
    }
  },
  "disabled_providers": ["opencode"]
}
```

### Script idempotency

- If `~/.opencode/bin/opencode` already exists and is executable: skip download
- If `~/.opencode/opencode.json` already exists: overwrite (re-running the script is safe)

---

## Extension Changes: Remove User-Visible opencode References

### `src/opencode.ts`

| Location | Before | After |
|---|---|---|
| CLI-not-found error (showErrorMessage) | `"OpenCode CLI not found. Please install it and ensure it's in PATH."` | `"Neusis Code engine not found. Please run the Neusis Code setup script."` |
| CLI-not-found button label | `'More Info'` → opens `anomalyco/opencode` | `'Setup Guide'` → opens GitHub release page |
| Output channel name | `'OpenChamberManager'` | `'Neusis Code'` |

### `src/extension.ts`

| Location | Before | After |
|---|---|---|
| Output channel | `'OpenChamber'` | `'Neusis Code'` |
| showErrorMessage on `openchamber.openSidebar` fail | `"OpenChamber: Failed to open sidebar"` | `"Neusis Code: Failed to open sidebar"` |
| showInformationMessage on restartApi | `"OpenChamber: API connection restarted"` | `"Neusis Code: API connection restarted"` |
| showErrorMessage on restartApi fail | `"OpenChamber: Failed to restart API"` | `"Neusis Code: Failed to restart API"` |

The `~/.opencode/` directory name, binary name, and all internal log messages
(output channel lines) are not user-visible and do not need rebranding.

---

## Files to Create

```
scripts/setup.sh     ← macOS / Linux setup script
scripts/setup.ps1    ← Windows setup script
```

---

## Out of Scope

- VS Code settings key rebranding (`openchamber.*` → `neusis.*`) — deferred
- Extension-native first-run wizard — not needed with script approach
- Automated `.vsix` install from the script — not included (users run `code --install-extension` manually)
