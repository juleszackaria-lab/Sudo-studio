/**
 * SUDO STUDIO - Sudo Agent activity-bar view (MISSION P4 g).
 * Slim launcher shown under the dedicated "Sudo Agent" activity-bar icon:
 * a single button that opens/focuses the conversation editor tab.
 * Theme variables only, no emoji. ASCII-only.
 */
'use strict';

const vscode = require('vscode');

class AgentActivityView {
    static VIEW_ID = 'sudoAgentLauncher';

    constructor(extensionUri) {
        this.extensionUri = extensionUri || null;
        this.view = null;
    }

    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
        view.webview.onDidReceiveMessage((m) => {
            if (m && m.type === 'open') {
                vscode.commands.executeCommand('sudoAgent.open');
            }
        });
    }

    _html() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
        'style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">\n' +
        '<style>\n' +
        'body { font-family:var(--vscode-font-family); font-size:12px; padding:12px; ' +
        'color:var(--vscode-editor-foreground); background:transparent; }\n' +
        'h2 { font-size:12px; font-weight:600; margin-bottom:6px; }\n' +
        'p { color:var(--vscode-descriptionForeground); margin-bottom:10px; line-height:1.5; }\n' +
        '.btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); ' +
        'border:none; border-radius:2px; padding:6px 12px; font-size:12px; cursor:pointer; width:100%; }\n' +
        '.btn:hover { background:var(--vscode-button-hoverBackground); }\n' +
        '.hint { margin-top:10px; color:var(--vscode-descriptionForeground); font-size:11px; }\n' +
        'kbd { background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); ' +
        'border-radius:3px; padding:0 4px; font-family:inherit; }\n' +
        '</style>\n</head>\n<body>\n' +
        '<h2>Sudo Agent</h2>\n' +
        '<p>Agent de programmation autonome (moteur OpenCode local). La conversation s&rsquo;ouvre dans un onglet d&rsquo;&eacute;diteur.</p>\n' +
        '<button class="btn" id="openBtn">Ouvrir Sudo Agent</button>\n' +
        '<div class="hint">Raccourci : <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd></div>\n' +
        '<script nonce="' + nonce + '">\n' +
        '"use strict";\n' +
        'var vscode = acquireVsCodeApi();\n' +
        'document.getElementById("openBtn").addEventListener("click", function() {\n' +
        '  vscode.postMessage({ type: "open" });\n' +
        '});\n' +
        '</script>\n</body>\n</html>';
    }
}

module.exports = { AgentActivityView };
