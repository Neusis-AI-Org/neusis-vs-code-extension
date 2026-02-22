# Neusis Code

Neusis Code is a VS Code extension that embeds an AI chat interface directly in the editor, powered by the [OpenCode](https://opencode.ai) backend.

## Installation

Follow these step-by-step instructions to set up Neusis Code:

### Step 1: Download the Installation Files
1. Go to the [Releases](https://github.com/Neusis-AI-Org/neusis-vs-code-extension/releases) page
2. Download the following files:
   - `script.bat` (Windows batch file)
   - `script.ps1` (PowerShell script)
   - `.vsix` file (VS Code extension)

### Step 2: Run the Setup Script
1. **On Windows (PowerShell):**
   - Open PowerShell as Administrator
   - Navigate to the folder where you downloaded the files
   - Run: `.\release.ps1`
   
   Or use the batch file:
   - Open Command Prompt as Administrator
   - Navigate to the folder where you downloaded the files
   - Run: `release.bat`

### Step 3: Paste Your API Key
1. When prompted by the script, paste your API key
2. Press Enter to confirm

### Step 4: Install the Extension
1. Open VS Code
2. Go to **Extensions** (Ctrl+Shift+X)
3. Click the **"Install from VSIX..."** option
4. Select the `.vsix` file you downloaded

### Step 5: Restart VS Code
1. Close VS Code completely
2. Reopen VS Code
3. The Neusis Code extension should now be active and ready to use!

You're all set! 🎉

## License

MIT
