/**
 * SUDO STUDIO - STATE MANAGER
 * Gère l'état global de l'extension
 */

const vscode = require('vscode');
const EventEmitter = require('events');

class StateManager extends EventEmitter {
    constructor() {
        super();
        this.state = {
            backend: {
                connected: false,
                healthy: false,
                error: null
            },
            runtime: {
                status: 'unknown',
                modelLoaded: false,
                modelName: null,
                device: 'cpu'
            },
            chat: {
                currentModel: 'default',
                history: [],
                isProcessing: false
            },
            system: {
                sdks: [],
                issues: [],
                score: null
            },
            environment: {
                info: null,
                exportPath: null
            },
            devops: {
                dockerGenerated: false,
                cicdGenerated: false
            }
        };
    }

    /**
     * Update backend state
     */
    updateBackendState(update) {
        this.state.backend = { ...this.state.backend, ...update };
        this.emit('backend:update', this.state.backend);
        this.emit('state:change', this.state);
    }

    /**
     * Update runtime state
     */
    updateRuntimeState(update) {
        this.state.runtime = { ...this.state.runtime, ...update };
        this.emit('runtime:update', this.state.runtime);
        this.emit('state:change', this.state);
    }

    /**
     * Update chat state
     */
    updateChatState(update) {
        this.state.chat = { ...this.state.chat, ...update };
        this.emit('chat:update', this.state.chat);
        this.emit('state:change', this.state);
    }

    /**
     * Add message to chat history
     */
    addChatMessage(message) {
        this.state.chat.history.push(message);
        this.emit('chat:message', message);
        this.emit('state:change', this.state);
    }

    /**
     * Clear chat history
     */
    clearChatHistory() {
        this.state.chat.history = [];
        this.emit('chat:clear');
        this.emit('state:change', this.state);
    }

    /**
     * Update system state
     */
    updateSystemState(update) {
        this.state.system = { ...this.state.system, ...update };
        this.emit('system:update', this.state.system);
        this.emit('state:change', this.state);
    }

    /**
     * Update environment state
     */
    updateEnvironmentState(update) {
        this.state.environment = { ...this.state.environment, ...update };
        this.emit('environment:update', this.state.environment);
        this.emit('state:change', this.state);
    }

    /**
     * Update DevOps state
     */
    updateDevOpsState(update) {
        this.state.devops = { ...this.state.devops, ...update };
        this.emit('devops:update', this.state.devops);
        this.emit('state:change', this.state);
    }

    /**
     * Get current state
     */
    getState() {
        return this.state;
    }

    /**
     * Get backend state
     */
    getBackendState() {
        return this.state.backend;
    }

    /**
     * Get runtime state
     */
    getRuntimeState() {
        return this.state.runtime;
    }

    /**
     * Get chat state
     */
    getChatState() {
        return this.state.chat;
    }

    /**
     * Get system state
     */
    getSystemState() {
        return this.state.system;
    }

    /**
     * Check if backend is ready
     */
    isBackendReady() {
        return this.state.backend.connected && this.state.backend.healthy;
    }

    /**
     * Check if runtime is ready
     */
    isRuntimeReady() {
        return this.state.runtime.status === 'healthy' && this.state.runtime.modelLoaded;
    }
}

// Singleton instance
let instance = null;

function getStateManager() {
    if (!instance) {
        instance = new StateManager();
    }
    return instance;
}

module.exports = { StateManager, getStateManager };
