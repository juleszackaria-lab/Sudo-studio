/**
 * SUDO STUDIO - BACKEND SERVICE
 * Gère toutes les communications avec le backend enterprise
 */

const axios = require('axios');
const vscode = require('vscode');

class BackendService {
    constructor() {
        this.baseUrl = 'http://localhost:5000';
        this.runtimeUrl = 'http://localhost:6000';
        this.authToken = null;
        this.connected = false;
        this.statusCallbacks = [];
    }

    /**
     * Initialize connection to backend
     */
    async initialize() {
        const config = vscode.workspace.getConfiguration('sudoAi');
        this.baseUrl = config.get('backendUrl', 'http://localhost:5000');
        
        try {
            await this.login();
            await this.checkHealth();
            this.connected = true;
            this.notifyStatusChange({ connected: true, healthy: true });
            return true;
        } catch (error) {
            console.error('Backend initialization failed:', error);
            this.connected = false;
            this.notifyStatusChange({ connected: false, error: error.message });
            return false;
        }
    }

    /**
     * Login and get auth token
     */
    async login() {
        try {
            const response = await axios.post(`${this.baseUrl}/api/auth/login`, {
                username: 'admin',
                password: 'admin123'
            }, { timeout: 5000 });
            
            this.authToken = response.data.token;
            return this.authToken;
        } catch (error) {
            console.warn('Auto-login failed, using default token');
            this.authToken = 'default-dev-token';
            return this.authToken;
        }
    }

    /**
     * Check backend health
     */
    async checkHealth() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/system/health`, {
                timeout: 3000
            });
            return response.data;
        } catch (error) {
            throw new Error('Backend not responding');
        }
    }

    /**
     * Check AI runtime health
     */
    async checkRuntimeHealth() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/ai/health`, {
                headers: this.getHeaders(),
                timeout: 3000,
                validateStatus: () => true
            });
            return response.data;
        } catch (error) {
            return { status: 'offline', error: error.message };
        }
    }

    /**
     * AI CHAT - Send message
     */
    async sendChatMessage(message, model = 'default', context = '') {
        const response = await axios.post(`${this.baseUrl}/api/ai/chat`, {
            message,
            model,
            context
        }, {
            headers: this.getHeaders(),
            timeout: 60000
        });
        return response.data;
    }

    /**
     * AI MODELS - List available models
     */
    async listModels() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/ai/models`, {
                headers: this.getHeaders(),
                timeout: 5000,
                validateStatus: () => true
            });
            return response.data;
        } catch (error) {
            return { models: [], error: error.message };
        }
    }

    /**
     * DOCTOR - Run system diagnostic
     */
    async runDoctor() {
        const response = await axios.post(`${this.baseUrl}/api/system/doctor`, {}, {
            headers: this.getHeaders(),
            timeout: 30000
        });
        return response.data;
    }

    /**
     * AUTOFIX - Repair system issue
     */
    async autoFix(issueType, params = {}) {
        const response = await axios.post(`${this.baseUrl}/api/system/autofix`, {
            issueType,
            ...params
        }, {
            headers: this.getHeaders(),
            timeout: 120000
        });
        return response.data;
    }

    /**
     * PROJECT ANALYSIS - Analyze current project
     */
    async analyzeProject(projectPath) {
        const response = await axios.post(`${this.baseUrl}/api/project/analyze`, {
            path: projectPath
        }, {
            headers: this.getHeaders(),
            timeout: 60000
        });
        return response.data;
    }

    /**
     * ENVIRONMENT - Get environment info
     */
    async getEnvironmentInfo() {
        const response = await axios.get(`${this.baseUrl}/api/environment/info`, {
            headers: this.getHeaders(),
            timeout: 10000
        });
        return response.data;
    }

    /**
     * ENVIRONMENT - Export environment
     */
    async exportEnvironment() {
        const response = await axios.post(`${this.baseUrl}/api/environment/export`, {}, {
            headers: this.getHeaders(),
            timeout: 30000
        });
        return response.data;
    }

    /**
     * SDK INSTALLER - List SDKs
     */
    async listSDKs() {
        const response = await axios.get(`${this.baseUrl}/api/environment/sdks`, {
            headers: this.getHeaders(),
            timeout: 10000
        });
        return response.data;
    }

    /**
     * SDK INSTALLER - Install SDK
     */
    async installSDK(sdkName) {
        const response = await axios.post(`${this.baseUrl}/api/environment/install`, {
            sdk: sdkName
        }, {
            headers: this.getHeaders(),
            timeout: 600000 // 10 minutes for installation
        });
        return response.data;
    }

    /**
     * DEVOPS - Generate Docker
     */
    async generateDocker(projectPath, config = {}) {
        const response = await axios.post(`${this.baseUrl}/api/devops/docker/generate`, {
            projectPath,
            ...config
        }, {
            headers: this.getHeaders(),
            timeout: 30000
        });
        return response.data;
    }

    /**
     * DEVOPS - Generate CI/CD
     */
    async generateCICD(projectPath, platform = 'github') {
        const response = await axios.post(`${this.baseUrl}/api/devops/cicd/generate`, {
            projectPath,
            platform
        }, {
            headers: this.getHeaders(),
            timeout: 30000
        });
        return response.data;
    }

    /**
     * RUNTIME - Manage Python runtime
     */
    async getRuntimeStatus() {
        try {
            const response = await axios.get(`${this.runtimeUrl}/health`, {
                timeout: 3000
            });
            return response.data;
        } catch (error) {
            return { status: 'offline', error: error.message };
        }
    }

    /**
     * Get authentication headers
     */
    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`
        };
    }

    /**
     * Register status change callback
     */
    onStatusChange(callback) {
        this.statusCallbacks.push(callback);
    }

    /**
     * Notify status change
     */
    notifyStatusChange(status) {
        this.statusCallbacks.forEach(cb => cb(status));
    }

    /**
     * Check if backend is connected
     */
    isConnected() {
        return this.connected;
    }
}

// Singleton instance
let instance = null;

function getBackendService() {
    if (!instance) {
        instance = new BackendService();
    }
    return instance;
}

module.exports = { BackendService, getBackendService };
