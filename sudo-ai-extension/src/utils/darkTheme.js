/**
 * SUDO STUDIO — Dark Theme CSS
 * Shared dark theme for all WebView panels
 * 
 * Colors:
 * - Background: #0d1117 (GitHub dark bg)
 * - Cards: #161b22 with #21262d border
 * - Primary button: #2ea043 (GitHub green)
 * - Secondary button: #1f6feb (GitHub blue)
 * - Text: #e6edf3
 * - Border-radius: 8px
 */

function getDarkThemeCSS() {
    return `
    /* ─── SUDO STUDIO DARK THEME ─────────────────────────────────── */
    :root {
        --ss-bg:        #0d1117;
        --ss-card-bg:   #161b22;
        --ss-border:    #21262d;
        --ss-btn-green: #2ea043;
        --ss-btn-blue:  #1f6feb;
        --ss-text:      #e6edf3;
        --ss-text-muted:#7d8590;
        --ss-radius:    8px;
        --ss-input-bg:  #0d1117;
        --ss-hover:     #21262d;
        --ss-success:   #3fb950;
        --ss-warning:   #d29922;
        --ss-error:     #f85149;
        --ss-accent:    #58a6ff;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
        background: var(--ss-bg) !important;
        color: var(--ss-text) !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', sans-serif;
        font-size: 13px;
        line-height: 1.5;
        height: 100%;
    }

    /* ─── Cards ─────────────────────────────────────────────────── */
    .ss-card {
        background: var(--ss-card-bg);
        border: 1px solid var(--ss-border);
        border-radius: var(--ss-radius);
        padding: 14px 16px;
        margin-bottom: 10px;
    }

    .ss-section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ss-text-muted);
        margin-bottom: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--ss-border);
    }

    /* ─── Status indicators ─────────────────────────────────────── */
    .ss-status-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid var(--ss-border);
    }
    .ss-status-row:last-child { border-bottom: none; }

    .ss-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .ss-dot.ok      { background: var(--ss-success); }
    .ss-dot.loading { background: var(--ss-warning); animation: pulse 1s infinite; }
    .ss-dot.error   { background: var(--ss-error); }
    .ss-dot.offline { background: var(--ss-text-muted); }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }

    .ss-status-label { flex: 1; color: var(--ss-text); }
    .ss-status-value { color: var(--ss-text-muted); font-size: 11px; }

    /* ─── Buttons ──────────────────────────────────────────────── */
    .ss-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 7px 14px;
        border: none;
        border-radius: var(--ss-radius);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity .15s, transform .1s;
        text-decoration: none;
        white-space: nowrap;
    }
    .ss-btn:hover  { opacity: 0.85; }
    .ss-btn:active { transform: scale(0.97); }
    .ss-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .ss-btn-primary   { background: var(--ss-btn-green); color: #ffffff; }
    .ss-btn-secondary { background: var(--ss-btn-blue);  color: #ffffff; }
    .ss-btn-ghost     { background: transparent; color: var(--ss-text); border: 1px solid var(--ss-border); }
    .ss-btn-danger    { background: #b91c1c; color: #ffffff; }
    .ss-btn-warning   { background: #92400e; color: #fef3c7; }

    .ss-btn-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 8px;
    }
    .ss-btn-grid .ss-btn { width: 100%; }
    .ss-btn-full { width: 100%; margin-top: 8px; }

    /* ─── Inputs ───────────────────────────────────────────────── */
    .ss-input, .ss-textarea, .ss-select {
        background: var(--ss-input-bg);
        border: 1px solid var(--ss-border);
        border-radius: var(--ss-radius);
        color: var(--ss-text);
        padding: 8px 12px;
        font-size: 13px;
        font-family: inherit;
        width: 100%;
        outline: none;
        transition: border-color .15s;
    }
    .ss-input:focus, .ss-textarea:focus, .ss-select:focus {
        border-color: var(--ss-btn-blue);
    }
    .ss-textarea { resize: vertical; min-height: 80px; }
    .ss-select option { background: var(--ss-card-bg); }

    /* ─── Progress bar ──────────────────────────────────────────── */
    .ss-progress-bar {
        height: 6px;
        background: var(--ss-border);
        border-radius: 3px;
        overflow: hidden;
        margin: 8px 0;
    }
    .ss-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--ss-btn-blue), var(--ss-btn-green));
        transition: width .3s ease;
        border-radius: 3px;
    }
    .ss-progress-label {
        font-size: 11px;
        color: var(--ss-text-muted);
        text-align: right;
    }

    /* ─── Header banner ─────────────────────────────────────────── */
    .ss-header {
        background: var(--ss-card-bg);
        border-bottom: 1px solid var(--ss-border);
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
    }
    .ss-header-title {
        font-weight: 700;
        font-size: 14px;
        color: var(--ss-text);
    }
    .ss-header-subtitle {
        font-size: 11px;
        color: var(--ss-text-muted);
        margin-left: auto;
    }

    /* ─── Badges ────────────────────────────────────────────────── */
    .ss-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 600;
    }
    .ss-badge-green  { background: rgba(46,160,67,.15); color: var(--ss-success); border: 1px solid rgba(46,160,67,.3); }
    .ss-badge-blue   { background: rgba(31,111,235,.15); color: var(--ss-accent); border: 1px solid rgba(31,111,235,.3); }
    .ss-badge-orange { background: rgba(210,153,34,.15); color: var(--ss-warning); border: 1px solid rgba(210,153,34,.3); }
    .ss-badge-red    { background: rgba(248,81,73,.15); color: var(--ss-error); border: 1px solid rgba(248,81,73,.3); }

    /* ─── Code blocks ───────────────────────────────────────────── */
    pre, code {
        background: #0d1117;
        border: 1px solid var(--ss-border);
        border-radius: 4px;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 12px;
        color: #e6edf3;
    }
    pre { padding: 12px; overflow-x: auto; }
    code { padding: 1px 5px; }

    /* ─── Loader spinner ────────────────────────────────────────── */
    .ss-loader {
        display: inline-block;
        width: 14px; height: 14px;
        border: 2px solid var(--ss-border);
        border-top-color: var(--ss-btn-blue);
        border-radius: 50%;
        animation: spin .8s linear infinite;
    }

    /* ─── Toast notifications ───────────────────────────────────── */
    .ss-toast {
        position: fixed;
        bottom: 16px; right: 16px;
        background: var(--ss-card-bg);
        border: 1px solid var(--ss-border);
        border-radius: var(--ss-radius);
        padding: 10px 14px;
        color: var(--ss-text);
        font-size: 12px;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0,0,0,.5);
        transition: opacity .3s;
        max-width: 300px;
    }
    .ss-toast.success { border-left: 3px solid var(--ss-success); }
    .ss-toast.error   { border-left: 3px solid var(--ss-error); }
    .ss-toast.info    { border-left: 3px solid var(--ss-accent); }

    /* ─── Scrollbar ─────────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--ss-bg); }
    ::-webkit-scrollbar-thumb { background: var(--ss-border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #30363d; }

    /* ─── Dashboard specific ────────────────────────────────────── */
    .ss-dashboard {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }
    .ss-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
    }

    /* ─── Inline chat ───────────────────────────────────────────── */
    .ss-chat-bar {
        background: var(--ss-card-bg);
        border-top: 1px solid var(--ss-border);
        padding: 10px 12px;
        display: flex;
        gap: 8px;
        flex-shrink: 0;
    }
    .ss-chat-input {
        flex: 1;
        background: var(--ss-input-bg);
        border: 1px solid var(--ss-border);
        border-radius: var(--ss-radius);
        color: var(--ss-text);
        padding: 8px 12px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color .15s;
    }
    .ss-chat-input:focus { border-color: var(--ss-btn-blue); }
    `;
}

/**
 * Generate standard dark-themed dashboard HTML
 * with status rows + action buttons + inline chat
 */
function getDashboardHTML(config = {}) {
    const {
        title = 'Sudo Studio',
        subtitle = 'v2.1',
        statuses = [],
        buttons = [],
        showChat = true,
        nonce = Math.random().toString(36).slice(2)
    } = config;

    const statusRows = statuses.map(s => `
        <div class="ss-status-row">
            <span class="ss-dot ${s.status || 'offline'}"></span>
            <span class="ss-status-label">${s.label}</span>
            <span class="ss-status-value" id="${s.id || ''}">${s.value || ''}</span>
        </div>
    `).join('');

    const buttonRows = buttons.map(b => `
        <button class="ss-btn ss-btn-${b.type || 'primary'} ss-btn-full" onclick="${b.onclick || ''}" id="${b.id || ''}">
            ${b.icon ? b.icon + ' ' : ''}${b.label}
        </button>
    `).join('');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${getDarkThemeCSS()}</style>
<title>${title}</title>
</head>
<body>
<div class="ss-dashboard">
    <div class="ss-header">
        <strong class="ss-header-title">⚡ ${title}</strong>
        <span class="ss-header-subtitle">${subtitle}</span>
    </div>
    <div class="ss-content">
        <div class="ss-card">
            <div class="ss-section-title">Statut des services</div>
            ${statusRows || '<div class="ss-status-row"><span class="ss-dot loading"></span><span class="ss-status-label">Vérification...</span></div>'}
        </div>
        <div class="ss-card">
            <div class="ss-section-title">Actions</div>
            ${buttonRows}
        </div>
    </div>
    ${showChat ? `
    <div class="ss-chat-bar">
        <input class="ss-chat-input" id="chatInput" type="text" placeholder="Message à Sudo AI... (Entrée pour envoyer)">
        <button class="ss-btn ss-btn-primary" onclick="sendChat()">Envoyer</button>
    </div>` : ''}
</div>
</body>
</html>`;
}

module.exports = { getDarkThemeCSS, getDashboardHTML };
