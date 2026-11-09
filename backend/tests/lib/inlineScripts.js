/**
 * SUDO STUDIO - shared helper: inline scripts of a webview HTML string.
 *
 * WHY THIS EXISTS (P60 fix): several suites assumed the panel's client script
 * was the FIRST <script> block of the document. A later prompt added a CSP
 * shim block BEFORE it, so `html.split('<script>')[1]` and
 * `/<script>([\s\S]*?)<\/script>/` started returning the 3 kB shim instead of
 * the real client (16 kB). The suites then failed on strings that the product
 * does emit - a harness defect, not a product defect.
 *
 * Rules used here:
 *   - a <script> tag WITH a src attribute is not inline code: ignored.
 *   - `mainScript` = the LARGEST inline block (the app code).
 *   - `allInline`  = every inline block joined (for "is this string emitted
 *     anywhere in the client" assertions).
 */
'use strict';

function inlineScripts(html) {
    const src = String(html || '');
    const out = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const attrs = m[1] || '';
        if (/\bsrc\s*=/.test(attrs)) continue;
        out.push(m[2]);
    }
    return out;
}

function mainScript(html) {
    const blocks = inlineScripts(html);
    if (!blocks.length) return '';
    return blocks.reduce((a, b) => (a.length >= b.length ? a : b));
}

function allInline(html) {
    return inlineScripts(html).join('\n;\n');
}

module.exports = { inlineScripts, mainScript, allInline };
