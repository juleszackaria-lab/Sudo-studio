/**
 * SUDO STUDIO - P61: fake OpenAI-compatible provider.
 *
 * Deterministic replay of everything a small local model (or a dying runtime)
 * can do to the agent, without Windows, without a GPU and without any model:
 *
 *   { text: 'bonjour' }                                  plain answer
 *   { call: { name, args } }                             one tool call
 *   { calls: [{ name, args }, ...] }                     several in ONE answer
 *   { rawArgs: '{bad json' }                             truncated / invalid JSON
 *   { nonObjectArgs: true }                              arguments that are not an object
 *   { http: 500 }                                        provider error
 *   { delayMs: 90000 }                                   very slow answer
 *   { cutAfter: 'chunk' }                                socket dropped mid-stream
 *   { empty: true }                                      empty body
 *   { error: { code: 'invalid_tool_call', ... } }        runtime-level refusal
 *
 * A script is an array consumed in order; the last entry repeats forever
 * (unless `once: true` is set on it). Every request body is recorded, so a
 * test can assert what the agent actually sent.
 *
 * Pure Node + stdlib. ASCII only.
 */
'use strict';

const http = require('http');

const HOST = '127.0.0.1';

function toOpenAiCalls(entry, seq) {
  const list = Array.isArray(entry.calls) ? entry.calls : (entry.call ? [entry.call] : []);
  return list.map((c, i) => {
    let argText;
    if (typeof c.rawArgs === 'string') argText = c.rawArgs;
    else if (c.nonObjectArgs === true) argText = JSON.stringify(JSON.stringify(c.args === undefined ? [] : [c.args]));
    else argText = JSON.stringify(c.args === undefined ? {} : c.args);
    return {
      id: c.id || ('call-' + seq + '-' + i),
      type: 'function',
      function: { name: c.name || '', arguments: argText },
    };
  });
}

function createFakeProvider(script) {
  const chats = [];
  const queue = (script || []).slice();
  let seq = 0;

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (!(req.method === 'POST' && u.pathname === '/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { body = {}; }
      chats.push(body);
      seq += 1;
      let next = queue.length > 1 ? queue.shift() : (queue[0] || { text: 'ok' });
      if (typeof next === 'function') next = next(body, seq) || { text: 'ok' };

      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
      // Runtime qui TOMBE : on ferme le serveur (connexions refusees), puis on
      // reecoute le MEME port apres downFor ms (redemarrage supervise).
      if (next.downFor) {
        try { req.socket.destroy(); } catch (_) {}
        try { srv.close(); } catch (_) {}
        setTimeout(() => { try { srv.listen(PORT, HOST); } catch (_) {} }, next.downFor);
        return;
      }
      if (next.closeSocket) { try { req.socket.destroy(); } catch (_) {} return; }
      if (next.http && next.http !== 200) {
        res.writeHead(next.http, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'panne simulee ' + next.http } }));
        return;
      }
      if (next.empty === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('');
        return;
      }

      const msg = { role: 'assistant', content: next.text === undefined ? '' : String(next.text) };
      const calls = toOpenAiCalls(next, seq);
      if (calls.length) msg.tool_calls = calls;
      if (next.error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: next.error, choices: [] }));
        return;
      }

      if (body && body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const txt = msg.content;
        const chunks = txt ? txt.match(/[\s\S]{1,24}/g) : [''];
        for (const chunk of chunks) {
          if (next.cutAfter !== undefined && chunk.indexOf(String(next.cutAfter)) !== -1) {
            try { res.socket.destroy(); } catch (_) {}
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
    });
  });

  let PORT = 0;
  return new Promise((resolve) => {
    srv.listen(0, HOST, () => {
      PORT = srv.address().port;
      resolve({
        server: srv,
        port: srv.address().port,
        chats,
        baseUrl: 'http://' + HOST + ':' + srv.address().port,
        remaining: () => queue.length,
        close: () => new Promise((r) => { try { srv.close(() => r()); } catch (_) { r(); } }),
      });
    });
  });
}

/** Provider object as the agent expects it. */
function providerOf(fake) {
  return { type: 'local', baseUrl: fake.baseUrl, model: 'fake-model' };
}

module.exports = { createFakeProvider, providerOf };
