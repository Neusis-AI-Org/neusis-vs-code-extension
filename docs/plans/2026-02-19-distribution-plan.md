# Distribution: Setup Scripts + Extension Rebrand Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `neusis-code.vsix` via GitHub Releases with platform setup scripts that silently install the backend engine and configure the LiteLLM provider, with zero user-visible "opencode" references.

**Architecture:** Two bash/PowerShell setup scripts handle the silent backend install and config-file creation before users install the `.vsix`. The extension's user-visible error and notification strings are rebranded to "Neusis Code". A GitHub Release bundles all three artefacts.

**Tech Stack:** bash (macOS/Linux), PowerShell 5+ (Windows), TypeScript (extension), `@vscode/vsce` for packaging, `gh` CLI for GitHub Release creation.

---

## Task 1: Create `scripts/setup.sh` (macOS / Linux)

**Files:**
- Create: `scripts/setup.sh`

### Step 1: Create the scripts directory and stub file

```bash
mkdir -p scripts
touch scripts/setup.sh
chmod +x scripts/setup.sh
```

### Step 2: Write the script

Write the complete contents of `scripts/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Neusis Code Setup ────────────────────────────────────────────────────────
# Installs the Neusis Code engine and writes the provider configuration.
# Users never see the word "opencode" — all output uses "Neusis Code" branding.
# ─────────────────────────────────────────────────────────────────────────────

INSTALL_DIR="$HOME/.opencode/bin"
BINARY_PATH="$INSTALL_DIR/opencode"
CONFIG_PATH="$HOME/.opencode/opencode.json"
BASE_URL="https://litellm-proxy-1074011666170.us-central1.run.app/v1"

# ── Helpers ──────────────────────────────────────────────────────────────────
bold() { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()  { printf '\033[31m%s\033[0m' "$*"; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
bold "Neusis Code Setup"
echo ""
printf '─%.0s' {1..40}; echo ""
echo ""

# ── Detect OS / arch ─────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)
    red "Unsupported OS: $OS"
    echo ""
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)  ARCH_TAG="x64" ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  *)
    red "Unsupported architecture: $ARCH"
    echo ""
    exit 1
    ;;
esac

# opencode GitHub release asset naming convention:
# opencode-<platform>-<arch>  (no extension on Unix)
ASSET_NAME="opencode-${PLATFORM}-${ARCH_TAG}"
DOWNLOAD_URL="https://github.com/sst/opencode/releases/latest/download/${ASSET_NAME}"

# ── Install engine binary ────────────────────────────────────────────────────
if [ -x "$BINARY_PATH" ]; then
  printf '%-42s' "Neusis Code engine already installed..."
  green "skipped"
  echo ""
else
  printf '%-42s' "Downloading Neusis Code engine..."
  mkdir -p "$INSTALL_DIR"
  if curl -fsSL "$DOWNLOAD_URL" -o "$BINARY_PATH" 2>/dev/null; then
    chmod +x "$BINARY_PATH"
    green "done"
    echo ""
  else
    red "failed"
    echo ""
    echo "Could not download the Neusis Code engine."
    echo "Check your internet connection and try again."
    exit 1
  fi
fi

# ── Prompt for API key ───────────────────────────────────────────────────────
echo ""
printf 'Enter your Neusis Code API key: '
read -r API_KEY

if [ -z "$API_KEY" ]; then
  red "API key cannot be empty."
  echo ""
  exit 1
fi

# ── Write configuration ──────────────────────────────────────────────────────
printf '%-42s' "Writing configuration..."
mkdir -p "$(dirname "$CONFIG_PATH")"
cat > "$CONFIG_PATH" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Neusis Code",
      "options": {
        "baseURL": "${BASE_URL}",
        "apiKey": "${API_KEY}"
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
EOF
green "done"
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
bold "Setup complete!"
echo ""
echo "Install the Neusis Code extension with:"
echo ""
echo "  code --install-extension neusis-code-$(cat "$(dirname "$0")/../package.json" 2>/dev/null | grep '"version"' | head -1 | sed 's/.*: "\(.*\)".*/\1/' || echo 'x.x.x').vsix"
echo ""
echo "Or drag-and-drop the .vsix file into VS Code's Extensions panel."
echo ""
```

### Step 3: Verify script is executable and has correct line endings

```bash
file scripts/setup.sh
# Expected: scripts/setup.sh: Bourne-Again shell script, ASCII text executable

# On Windows dev machines, ensure Unix line endings:
# If you see ^M characters, run: sed -i 's/\r//' scripts/setup.sh
```

### Step 4: Smoke-test locally (dry run — skip actual download)

```bash
# Test OS/arch detection logic runs without errors
bash -n scripts/setup.sh
# Expected: no output (syntax OK)

# Test with fake binary already in place to exercise "skipped" path:
mkdir -p ~/.opencode/bin && touch ~/.opencode/bin/opencode && chmod +x ~/.opencode/bin/opencode
bash scripts/setup.sh <<< "sk-test-key-1234"
# Expected output includes:
#   Neusis Code engine already installed...  skipped
#   Writing configuration...                 done
#   Setup complete!
# Also check config was written:
cat ~/.opencode/opencode.json | grep '"apiKey"'
# Expected: "apiKey": "sk-test-key-1234"

# Clean up test artefacts:
rm -f ~/.opencode/bin/opencode
```

### Step 5: Commit

```bash
git add scripts/setup.sh
git commit -m "feat: add macOS/Linux setup script for Neusis Code"
```

---

## Task 2: Create `scripts/setup.ps1` (Windows)

**Files:**
- Create: `scripts/setup.ps1`

### Step 1: Write the script

Write the complete contents of `scripts/setup.ps1`:

```powershell
#Requires -Version 5.0
<#
.SYNOPSIS
    Neusis Code Setup — installs the engine and configures the provider.
.DESCRIPTION
    Downloads the Neusis Code engine binary and writes the provider
    configuration file. Run once per machine before installing the extension.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir  = Join-Path $env:USERPROFILE '.opencode\bin'
$BinaryPath  = Join-Path $InstallDir 'opencode.exe'
$ConfigDir   = Join-Path $env:USERPROFILE '.opencode'
$ConfigPath  = Join-Path $ConfigDir 'opencode.json'
$BaseURL     = 'https://litellm-proxy-1074011666170.us-central1.run.app/v1'

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Neusis Code Setup" -ForegroundColor White
Write-Host ("─" * 40)
Write-Host ""

# ── Detect arch ──────────────────────────────────────────────────────────────
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$archTag = switch ($arch) {
    'X64'   { 'x64' }
    'Arm64' { 'arm64' }
    default {
        Write-Host "Unsupported architecture: $arch" -ForegroundColor Red
        exit 1
    }
}

$assetName   = "opencode-win32-${archTag}.exe"
$downloadUrl = "https://github.com/sst/opencode/releases/latest/download/${assetName}"

# ── Install engine binary ────────────────────────────────────────────────────
if (Test-Path $BinaryPath) {
    Write-Host ("Neusis Code engine already installed...".PadRight(42)) -NoNewline
    Write-Host "skipped" -ForegroundColor Green
} else {
    Write-Host ("Downloading Neusis Code engine...".PadRight(42)) -NoNewline
    try {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Invoke-WebRequest -Uri $downloadUrl -OutFile $BinaryPath -UseBasicParsing
        Write-Host "done" -ForegroundColor Green
    } catch {
        Write-Host "failed" -ForegroundColor Red
        Write-Host "Could not download the Neusis Code engine."
        Write-Host "Check your internet connection and try again."
        exit 1
    }
}

# ── Prompt for API key ───────────────────────────────────────────────────────
Write-Host ""
$apiKeySecure = Read-Host "Enter your Neusis Code API key"
$apiKey = $apiKeySecure.Trim()

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "API key cannot be empty." -ForegroundColor Red
    exit 1
}

# ── Write configuration ──────────────────────────────────────────────────────
Write-Host ("Writing configuration...".PadRight(42)) -NoNewline

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

$config = @"
{
  "`$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Neusis Code",
      "options": {
        "baseURL": "$BaseURL",
        "apiKey": "$apiKey"
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
"@

[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.Encoding]::UTF8)
Write-Host "done" -ForegroundColor Green

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor White
Write-Host ""
Write-Host "Install the Neusis Code extension with:"
Write-Host ""
Write-Host "  code --install-extension neusis-code-x.x.x.vsix"
Write-Host ""
Write-Host "Or drag-and-drop the .vsix file into VS Code's Extensions panel."
Write-Host ""
```

### Step 2: Smoke-test on Windows

Open PowerShell and run:

```powershell
# Syntax check (parse without executing)
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path scripts\setup.ps1).Path, [ref]$null, [ref]$null
)
# Expected: no output (parse OK)

# Test with fake binary already present:
New-Item -Force -ItemType Directory "$env:USERPROFILE\.opencode\bin" | Out-Null
"fake" | Set-Content "$env:USERPROFILE\.opencode\bin\opencode.exe"
echo "sk-test-key-win" | powershell -File scripts\setup.ps1
# Expected:
#   Neusis Code engine already installed...  skipped
#   Writing configuration...                 done
#   Setup complete!

# Verify config:
Get-Content "$env:USERPROFILE\.opencode\opencode.json" | Select-String apiKey
# Expected: "apiKey": "sk-test-key-win"

# Clean up:
Remove-Item "$env:USERPROFILE\.opencode\bin\opencode.exe"
```

### Step 3: Commit

```bash
git add scripts/setup.ps1
git commit -m "feat: add Windows setup script for Neusis Code"
```

---

## Task 3: Rebrand user-visible messages in `src/opencode.ts`

**Files:**
- Modify: `src/opencode.ts:262` (output channel name)
- Modify: `src/opencode.ts:472-480` (CLI-not-found error + button)
- Modify: `src/opencode.ts:482` (generic start failure message)

### Step 1: Fix output channel name (line 262)

In `src/opencode.ts`, change:
```typescript
// line 262 — BEFORE
const outputChannel = vscode.window.createOutputChannel('OpenChamberManager');
```
To:
```typescript
// line 262 — AFTER
const outputChannel = vscode.window.createOutputChannel('Neusis Code');
```

> **Note:** There are now two output channels named `'Neusis Code'` (this one and the one in `extension.ts`). VS Code deduplicates by appending `(2)` etc., which is fine — they are both internal diagnostic channels that end users rarely open.

### Step 2: Fix CLI-not-found error and button (lines 472–480)

In `src/opencode.ts`, replace the entire `if (message.includes('ENOENT')...)` block:

**Before (lines 467–480):**
```typescript
      if (message.includes('ENOENT') || message.includes('spawn opencode')) {
        cliMissing = true;
        if (!cliPath) {
          cliPath = resolveOpencodeCliPath();
        }
        setStatus('error', 'OpenCode CLI not found. Install it and ensure it\'s in PATH.');
        vscode.window.showErrorMessage(
          'OpenCode CLI not found. Please install it and ensure it\'s in PATH.',
          'More Info'
        ).then(selection => {
          if (selection === 'More Info') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/anomalyco/opencode'));
          }
        });
```

**After:**
```typescript
      if (message.includes('ENOENT') || message.includes('spawn opencode')) {
        cliMissing = true;
        if (!cliPath) {
          cliPath = resolveOpencodeCliPath();
        }
        setStatus('error', 'Neusis Code engine not found. Please run the Neusis Code setup script.');
        vscode.window.showErrorMessage(
          'Neusis Code engine not found. Please run the Neusis Code setup script.',
          'Setup Guide'
        ).then(selection => {
          if (selection === 'Setup Guide') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/Neusis/openchamber/releases/latest'));
          }
        });
```

### Step 3: Fix generic start failure message (line 482)

**Before:**
```typescript
        setStatus('error', `Failed to start OpenCode: ${message}`);
```
**After:**
```typescript
        setStatus('error', `Neusis Code engine failed to start: ${message}`);
```

### Step 4: Type-check

```bash
bun run type-check
# Expected: no errors
```

### Step 5: Commit

```bash
git add src/opencode.ts
git commit -m "fix: rebrand user-visible opencode references in opencode.ts"
```

---

## Task 4: Rebrand user-visible messages in `src/extension.ts`

**Files:**
- Modify: `src/extension.ts:35` (output channel)
- Modify: `src/extension.ts:147` (sidebar error)
- Modify: `src/extension.ts:186` (no active session info)
- Modify: `src/extension.ts:222` (restart success)
- Modify: `src/extension.ts:224` (restart failure)
- Modify: `src/extension.ts:233,241` (add-to-context warnings)
- Modify: `src/extension.ts:269` (explain warning)
- Modify: `src/extension.ts:301,309` (improve-code warnings)

> **Scope rule:** Only change strings that appear in `showErrorMessage`, `showWarningMessage`, `showInformationMessage` calls (user-visible). Leave `outputChannel.appendLine` log lines and internal comments unchanged — they are not user-visible.

### Step 1: Fix output channel name (line 35)

```typescript
// BEFORE
outputChannel = vscode.window.createOutputChannel('OpenChamber');
// AFTER
outputChannel = vscode.window.createOutputChannel('Neusis Code');
```

### Step 2: Fix showErrorMessage on sidebar open fail (line 147)

```typescript
// BEFORE
vscode.window.showErrorMessage(`OpenChamber: Failed to open sidebar - ${e}`);
// AFTER
vscode.window.showErrorMessage(`Neusis Code: Failed to open sidebar - ${e}`);
```

### Step 3: Fix showInformationMessage for no active session (line 186)

```typescript
// BEFORE
vscode.window.showInformationMessage('OpenChamber: No active session');
// AFTER
vscode.window.showInformationMessage('Neusis Code: No active session');
```

### Step 4: Fix restart API messages (lines 222–224)

```typescript
// BEFORE
vscode.window.showInformationMessage('OpenChamber: API connection restarted');
// ...
vscode.window.showErrorMessage(`OpenChamber: Failed to restart API - ${e}`);

// AFTER
vscode.window.showInformationMessage('Neusis Code: API connection restarted');
// ...
vscode.window.showErrorMessage(`Neusis Code: Failed to restart API - ${e}`);
```

### Step 5: Fix Add to Context warnings (lines 233, 241)

```typescript
// BEFORE
vscode.window.showWarningMessage('OpenChamber [Add to Context]:No active editor');
// ...
vscode.window.showWarningMessage('OpenChamber [Add to Context]: No text selected');

// AFTER
vscode.window.showWarningMessage('Neusis Code [Add to Context]: No active editor');
// ...
vscode.window.showWarningMessage('Neusis Code [Add to Context]: No text selected');
```

### Step 6: Fix Explain warning (line 269)

```typescript
// BEFORE
vscode.window.showWarningMessage('OpenChamber [Explain]: No active editor');
// AFTER
vscode.window.showWarningMessage('Neusis Code [Explain]: No active editor');
```

### Step 7: Fix Improve Code warnings (lines 301, 309)

```typescript
// BEFORE
vscode.window.showWarningMessage('OpenChamber [Improve Code]: No active editor');
// ...
vscode.window.showWarningMessage('OpenChamber [Improve Code]: No text selected');

// AFTER
vscode.window.showWarningMessage('Neusis Code [Improve Code]: No active editor');
// ...
vscode.window.showWarningMessage('Neusis Code [Improve Code]: No text selected');
```

### Step 8: Type-check

```bash
bun run type-check
# Expected: no errors
```

### Step 9: Commit

```bash
git add src/extension.ts
git commit -m "fix: rebrand user-visible OpenChamber references in extension.ts"
```

---

## Task 5: Build the `.vsix` and create the GitHub Release

**Prerequisites:** Tasks 1–4 complete. `gh` CLI installed and authenticated (`gh auth status`).

### Step 1: Install dependencies and build

```bash
bun install
bun run build
# Expected: dist/extension.js and dist/webview/ produced with no errors
```

### Step 2: Type-check one final time

```bash
bun run type-check
# Expected: no errors
```

### Step 3: Package the extension

```bash
bun run package
# Expected: produces neusis-code-1.6.8.vsix in the repo root
ls *.vsix
# Expected: neusis-code-1.6.8.vsix
```

### Step 4: Verify the .vsix contents look sane

```bash
# List top-level entries in the package
unzip -l neusis-code-1.6.8.vsix | head -30
# Expected: extension/dist/extension.js, extension/dist/webview/*, extension/package.json
# NOT expected: node_modules/ (dependencies should be bundled, not included raw)
```

### Step 5: Tag the release commit

```bash
git tag v1.6.8
# (If v1.6.8 already exists from a previous attempt, increment package.json version first)
```

### Step 6: Create the GitHub Release

```bash
gh release create v1.6.8 \
  neusis-code-1.6.8.vsix \
  scripts/setup.sh \
  scripts/setup.ps1 \
  --title "Neusis Code v1.6.8" \
  --notes "$(cat <<'EOF'
## Neusis Code v1.6.8

### Installation

1. **Run the setup script for your platform:**

   **macOS / Linux:**
   ```bash
   bash setup.sh
   ```

   **Windows (PowerShell):**
   ```powershell
   .\setup.ps1
   ```

   The script will ask for your Neusis Code API key and set everything up automatically.

2. **Install the extension:**
   ```
   code --install-extension neusis-code-1.6.8.vsix
   ```
   Or drag-and-drop `neusis-code-1.6.8.vsix` into VS Code's Extensions panel.

### Requirements

- VS Code 1.85 or later
- macOS, Linux, or Windows (x64 or arm64)
- Your Neusis Code API key (issued by your administrator)
EOF
)"
```

### Step 7: Verify the release

```bash
gh release view v1.6.8
# Expected: shows title, notes, and three assets:
#   neusis-code-1.6.8.vsix
#   setup.sh
#   setup.ps1
```

---

## Verification Checklist (run before declaring done)

- [ ] `bash -n scripts/setup.sh` — syntax OK
- [ ] `bun run type-check` — zero TypeScript errors
- [ ] `bun run build` — builds without errors
- [ ] `bun run package` — produces `neusis-code-1.6.8.vsix`
- [ ] `grep -r "OpenCode CLI not found\|anomalyco" src/` — returns nothing
- [ ] `grep -r "'OpenChamber'" src/` — returns nothing (only internal log prefixes remain)
- [ ] GitHub Release has all three assets attached
