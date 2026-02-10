import * as vscode from 'vscode';
import { NeusisChatViewProvider } from './webview-provider';

let chatProvider: NeusisChatViewProvider;

export function activate(context: vscode.ExtensionContext): void {
  chatProvider = new NeusisChatViewProvider(context.extensionUri);

  // Register the webview view provider for the sidebar panel
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NeusisChatViewProvider.viewType,
      chatProvider,
    ),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('neusis-code.newChat', () => {
      chatProvider.newChat();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('neusis-code.stopGeneration', () => {
      chatProvider.stopGeneration();
    }),
  );

  // Accept/Reject file change commands (triggered by CodeLens in editor)
  context.subscriptions.push(
    vscode.commands.registerCommand('neusis-code.acceptFileChanges', (filePath: string) => {
      chatProvider.changeTracker.acceptFile(filePath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('neusis-code.rejectFileChanges', (filePath: string) => {
      chatProvider.changeTracker.rejectFile(filePath);
    }),
  );
}

export function deactivate(): void {
  // ClaudeProcess is stopped when webview disposes
}
