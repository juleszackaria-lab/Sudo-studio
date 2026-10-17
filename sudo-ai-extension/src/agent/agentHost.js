'use strict';
// agentHost (P27): registry wiring the Agent/Chat panels to the supervised
// sudo-agent server owned by extension.js.
//
// extension.js sets the hooks once at activation (setAgentHost); panels read
// them when they create their engine. This avoids changing the panel
// createOrShow() signatures pinned by the P4/P5 suites.
// Hooks: getServer() -> AgentServer|null, gateAgent()/gateChat() async gates
// (license + provider config, throw localized errors), relaunch() async,
// serverState() -> { status, detail }. Source is ASCII-only.

let hooks = {
    getServer: null,
    gateAgent: null,
    gateChat: null,
    relaunch: null,
    serverState: null,
};

function setAgentHost(partial = {}) {
    for (const k of Object.keys(hooks)) {
        if (typeof partial[k] === 'function') hooks[k] = partial[k];
    }
}

function getAgentHost() {
    return hooks;
}

function resetAgentHost() {
    hooks = { getServer: null, gateAgent: null, gateChat: null, relaunch: null, serverState: null };
}

module.exports = { setAgentHost, getAgentHost, resetAgentHost };
