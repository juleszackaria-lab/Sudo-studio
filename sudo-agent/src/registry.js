// Sudo Agent tool registry + permissions (P24, step 1).
// The REGISTRY (register/list/get) and the permission model exist; NO tool is
// registered at this step, and nothing can register one remotely. Seams only.
// Stdlib only. ASCII only.
'use strict';

const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;

function createRegistry() {
  const tools = new Map();

  function registerTool(def) {
    if (!def || typeof def !== 'object') return { ok: false, error: 'bad tool definition' };
    const name = def.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'bad tool name' };
    if (typeof def.description !== 'string' || !def.description.trim()) return { ok: false, error: 'tool description required' };
    if (typeof def.handler !== 'function') return { ok: false, error: 'tool handler required' };
    if (tools.has(name)) return { ok: false, error: 'tool already registered' };
    tools.set(name, {
      name,
      description: def.description.trim().slice(0, 500),
      parameters: def.parameters && typeof def.parameters === 'object' ? def.parameters : null,
      danger: def.danger === 'write' || def.danger === 'execute' ? def.danger : 'read',
      handler: def.handler,
    });
    return { ok: true };
  }

  // Public view: never leaks handlers.
  function listTools() {
    return Array.from(tools.values()).map((t) => ({ name: t.name, description: t.description, danger: t.danger }));
  }

  function getTool(name) {
    return tools.get(name) || null;
  }

  // Step 1 policy: default deny. With zero tools, nothing is ever allowed.
  function getPermissions() {
    return {
      mode: 'deny-all',
      tools: [],
      note: 'Step 1: no tools registered; the agent answers with the model only.',
    };
  }

  function check(_toolName) {
    return { allowed: false, reason: 'tools unavailable (step 1: registry empty)' };
  }

  return { registerTool, listTools, getTool, getPermissions, check };
}

module.exports = { createRegistry };
