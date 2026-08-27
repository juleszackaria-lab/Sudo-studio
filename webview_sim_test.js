const { JSDOM } = require('jsdom');
const Module = require('module');

// Stub vscode + axios modules so ChatPanel.js can be required in Node
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(req, ...args) {
  if (req === 'vscode') return req;
  if (req === 'axios') return req;
  return origResolve.call(this, req, ...args);
};
require.cache['vscode'] = { id:'vscode', filename:'vscode', loaded:true, exports: {
  window:{ activeTextEditor:null, createWebviewPanel:()=>({}), showInformationMessage:()=>{} },
  commands:{ executeCommand:()=>{} }, ViewColumn:{ One:1 }, Uri:{}
}};
require.cache['axios'] = { id:'axios', filename:'axios', loaded:true, exports: {
  get: () => Promise.reject(new Error('no net')),
  post: () => Promise.reject(new Error('no net'))
}};

const { ChatPanel } = require('/home/user/webapp/sudo-ai-extension/src/panels/ChatPanel.js');

// Build a minimal fake panel/webview to capture postMessage calls from extension side
const receivedFromWebview = [];
const fakeWebview = {
  html: '',
  onDidReceiveMessage: (cb) => { fakeWebview._cb = cb; },
  postMessage: (msg) => { receivedFromWebview.push(msg); return Promise.resolve(true); }
};
const fakePanel = {
  webview: fakeWebview,
  onDidDispose: () => {},
  reveal: () => {}
};

const cp = new ChatPanel(fakePanel, null, null);
const html = fakeWebview.html;
console.log('HTML length:', html.length);

// Now load this HTML into jsdom, with acquireVsCodeApi injected like real VSCode does
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'https://file+.vscode-resource.vscode-cdn.net/fake/index.html',
  beforeParse(window) {
    // VSCode injects acquireVsCodeApi as a global function
    const postedToExtension = [];
    window.acquireVsCodeApi = function() {
      return {
        postMessage: function(msg) {
          postedToExtension.push(msg);
          // simulate round trip to extension handleMessage
          if (fakeWebview._cb) fakeWebview._cb(msg);
        },
        getState: () => undefined,
        setState: () => {}
      };
    };
    window.__postedToExtension = postedToExtension;
    window.console.log = (...a) => console.log('[webview console.log]', ...a);
    window.console.warn = (...a) => console.log('[webview console.warn]', ...a);
    window.console.error = (...a) => console.log('[webview console.error]', ...a);
  }
});

// Wait a tick for scripts to execute (jsdom runs sync scripts immediately, but let's be safe)
setTimeout(() => {
  const { window } = dom;
  const doc = window.document;

  console.log('--- After load ---');
  console.log('typeof window.sendMsg (should be function, but it is inside script scope, not necessarily global):', typeof window.sendMsg);

  const sendBtn = doc.getElementById('sendBtn');
  const input = doc.getElementById('msgInput');
  console.log('sendBtn found:', !!sendBtn, 'disabled:', sendBtn && sendBtn.disabled);
  console.log('input found:', !!input);

  if (input) {
    input.value = 'Test message from jsdom';
    // dispatch input event to trigger the "input" listener (auto height)
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  if (sendBtn) {
    console.log('Clicking sendBtn...');
    sendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  }

  setTimeout(() => {
    console.log('--- postMessage calls captured from webview -> extension ---');
    console.log(JSON.stringify(window.__postedToExtension, null, 2));
    console.log('--- postMessage calls captured from extension -> webview (fakeWebview.postMessage) ---');
    console.log(JSON.stringify(receivedFromWebview, null, 2));
    console.log('--- input.value after click (should be empty if cleared) ---');
    console.log(JSON.stringify(input.value));
    process.exit(0);
  }, 200);
}, 100);
