#!/usr/bin/env bash
set -euo pipefail

# ── Neusis Code Setup ────────────────────────────────────────────────────────
# Installs the Neusis Code engine and writes the provider configuration.
# Users never see the word "opencode" — all output uses "Neusis Code" branding.
# ─────────────────────────────────────────────────────────────────────────────

INSTALL_DIR="$HOME/.opencode/bin"
BINARY_PATH="$INSTALL_DIR/opencode"
CONFIG_PATH="$HOME/.config/opencode/opencode.json"
BASE_URL="https://litellm-proxy-1074011666170.us-central1.run.app/v1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Validate environment ──────────────────────────────────────────────────────
if [ -z "${HOME:-}" ]; then
  printf '\033[31m%s\033[0m\n' "Error: HOME directory is not set."
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
bold()   { printf '\033[1m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
red()    { printf '\033[31m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }

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
  x86_64)        ARCH_TAG="x64" ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  *)
    red "Unsupported architecture: $ARCH"
    echo ""
    exit 1
    ;;
esac

# Asset names from https://github.com/anomalyco/opencode/releases
ARCHIVE_NAME="opencode-${PLATFORM}-${ARCH_TAG}.tar.gz"
DOWNLOAD_URL="https://github.com/anomalyco/opencode/releases/latest/download/${ARCHIVE_NAME}"

# ── Install engine binary ────────────────────────────────────────────────────
# Priority: already installed → local archive next to script → download

LOCAL_ARCHIVE="$SCRIPT_DIR/$ARCHIVE_NAME"

if [ -x "$BINARY_PATH" ]; then
  printf '%-42s' "Neusis Code engine already installed..."
  green "skipped"
  echo ""
elif [ -f "$LOCAL_ARCHIVE" ]; then
  printf '%-42s' "Installing Neusis Code engine (local)..."
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$LOCAL_ARCHIVE" -C "$INSTALL_DIR" --strip-components=0 opencode 2>/dev/null || \
    tar -xzf "$LOCAL_ARCHIVE" -C "$INSTALL_DIR" 2>/dev/null
  chmod +x "$BINARY_PATH"
  green "done"
  echo ""
else
  printf '%-42s' "Downloading Neusis Code engine..."
  mkdir -p "$INSTALL_DIR"
  TMP_ARCHIVE="$(mktemp).tar.gz"
  if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_ARCHIVE" 2>/dev/null; then
    tar -xzf "$TMP_ARCHIVE" -C "$INSTALL_DIR" --strip-components=0 opencode 2>/dev/null || \
      tar -xzf "$TMP_ARCHIVE" -C "$INSTALL_DIR" 2>/dev/null
    rm -f "$TMP_ARCHIVE"
    chmod +x "$BINARY_PATH"
    green "done"
    echo ""
  else
    rm -f "$TMP_ARCHIVE"
    red "failed"
    echo ""
    echo "Could not download the Neusis Code engine."
    echo "For offline installs: place $ARCHIVE_NAME next to this script and run again."
    exit 1
  fi
fi

# ── Migrate old config if present ────────────────────────────────────────────
OLD_CONFIG_PATH="$HOME/.opencode/opencode.json"
if [ -f "$OLD_CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
  printf '%-42s' "Migrating existing configuration..."
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cp "$OLD_CONFIG_PATH" "$CONFIG_PATH"
  green "done"
  echo ""
  echo ""
  bold "Setup complete!"
  echo ""
  echo "Install the Neusis Code extension with:"
  echo ""
  echo "  code --install-extension neusis-code-x.x.x.vsix"
  echo ""
  echo "Or drag-and-drop the .vsix file into VS Code's Extensions panel."
  echo ""
  exit 0
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

# ── Fetch available models ────────────────────────────────────────────────────
printf '%-42s' "Fetching available models..."

_MODELS_URL="${BASE_URL}/models?return_wildcard_routes=false&include_model_access_groups=false&only_model_access_groups=false&include_metadata=false"
MODELS_BLOCK=""
_MODELS_RESPONSE=""

_MODELS_RESPONSE=$(curl -fsSL \
  -H "accept: application/json" \
  -H "x-litellm-api-key: ${API_KEY}" \
  "$_MODELS_URL" 2>/dev/null) || _MODELS_RESPONSE=""

if [ -n "$_MODELS_RESPONSE" ]; then
  if command -v jq >/dev/null 2>&1; then
    MODELS_BLOCK=$(printf '%s' "$_MODELS_RESPONSE" | jq -r '
      (.data // []) | map(.id) |
      map(. as $id |
        ($id | gsub("[-_/]"; " ") | split(" ") |
          map(ascii_upcase[0:1] + .[1:]) | join(" ")) as $name |
        "        \"\($id)\": {\n          \"name\": \"\($name)\"\n        }"
      ) | join(",\n")
    ' 2>/dev/null) || MODELS_BLOCK=""
  elif command -v python3 >/dev/null 2>&1; then
    MODELS_BLOCK=$(printf '%s' "$_MODELS_RESPONSE" | python3 -c "
import json, sys, re
data = json.load(sys.stdin)
lines = []
for m in data.get('data', []):
    mid = m['id']
    name = re.sub(r'[-_/]', ' ', mid)
    name = ' '.join(w.capitalize() for w in name.split())
    lines.append('        \"%s\": {\n          \"name\": \"%s\"\n        }' % (mid, name))
print(',\n'.join(lines))
" 2>/dev/null) || MODELS_BLOCK=""
  fi
fi

if [ -n "$MODELS_BLOCK" ]; then
  _MODEL_COUNT=$(printf '%s' "$MODELS_BLOCK" | grep -c '"name"' 2>/dev/null) || _MODEL_COUNT="?"
  green "done (${_MODEL_COUNT} models)"
else
  yellow "using defaults"
  MODELS_BLOCK='        "github_copilot/gpt-4": {
          "name": "Github Copilot Gpt 4"
        },
        "github_copilot/gpt-5.1-codex": {
          "name": "Github Copilot Gpt 5.1 Codex"
        },
        "gemini/gemini-pro-latest": {
          "name": "Gemini Gemini Pro Latest"
        },
        "gemini-flash-latest": {
          "name": "Gemini Flash Latest"
        },
        "gemini-flash-lite-latest": {
          "name": "Gemini Flash Lite Latest"
        }'
fi
echo ""

# ── Write configuration ──────────────────────────────────────────────────────
printf '%-42s' "Writing configuration..."
mkdir -p "$(dirname "$CONFIG_PATH")"
cat > "$CONFIG_PATH" <<ENDOFCONFIG
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
${MODELS_BLOCK}
      }
    }
  },
  "disabled_providers": ["opencode"]
}
ENDOFCONFIG
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
