const vscode = require('vscode');

function activate(context) {
  const disposable = vscode.commands.registerCommand('sudo-studio.openUI', function () {
    const panel = vscode.window.createWebviewPanel(
      'sudoStudioUI',
      'Sudo Studio',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Prefer backend-served UI if available
    const uiUrl = 'http://localhost:5000/ui/index.html';

    panel.webview.html = `<!doctype html><meta charset="utf-8"><style>body,html{height:100%;margin:0}</style><iframe src="${uiUrl}" style="border:0;width:100%;height:100%"></iframe>`;
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
