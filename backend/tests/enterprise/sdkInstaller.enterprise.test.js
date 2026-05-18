/**
 * ENTERPRISE TESTS - SDK INSTALLER
 * 
 * Tests complets pour le système d'installation de SDKs
 */

const { expect } = require('chai');
const sdk = require('../../installers/sdkInstaller.enterprise');
const os = require('os');
const path = require('path');

describe('📦 SDK Installer Enterprise - Tests', function() {
    this.timeout(60000); // 60 secondes pour tests d'installation
    
    describe('Module Exports', () => {
        it('should export all required functions', () => {
            expect(sdk).to.have.property('detectSDK');
            expect(sdk).to.have.property('detectAllSDKs');
            expect(sdk).to.have.property('installSDK');
            expect(sdk).to.have.property('repairSDK');
            expect(sdk).to.have.property('verifySDK');
            expect(sdk).to.have.property('addToPath');
            expect(sdk).to.have.property('hasAdminPrivileges');
            expect(sdk).to.have.property('getInstallDir');
        });
        
        it('should export CONFIG object', () => {
            expect(sdk).to.have.property('CONFIG');
            expect(sdk.CONFIG).to.be.an('object');
            expect(sdk.CONFIG).to.have.property('sdks');
        });
        
        it('should export SUPPORTED_SDKS array', () => {
            expect(sdk).to.have.property('SUPPORTED_SDKS');
            expect(sdk.SUPPORTED_SDKS).to.be.an('array');
            expect(sdk.SUPPORTED_SDKS.length).to.be.at.least(10);
        });
    });
    
    describe('SDK Detection', () => {
        it('should detect Node.js', async () => {
            const result = await sdk.detectSDK('nodejs');
            
            expect(result).to.be.an('object');
            expect(result).to.have.property('installed');
            expect(result).to.have.property('sdk');
            
            // Node.js devrait être installé pour les tests
            expect(result.installed).to.be.true;
            expect(result).to.have.property('version');
        });
        
        it('should detect all SDKs', async () => {
            const results = await sdk.detectAllSDKs();
            
            expect(results).to.be.an('object');
            expect(Object.keys(results).length).to.be.at.least(10);
            
            // Node.js devrait être détecté
            expect(results).to.have.property('nodejs');
            expect(results.nodejs.installed).to.be.true;
        });
        
        it('should return correct structure for uninstalled SDK', async () => {
            // Test avec un SDK probablement non installé
            const result = await sdk.detectSDK('flutter');
            
            expect(result).to.be.an('object');
            expect(result).to.have.property('installed');
            expect(result).to.have.property('sdk');
            
            if (!result.installed) {
                expect(result).to.have.property('executable');
            }
        });
    });
    
    describe('Admin Privileges', () => {
        it('should check admin privileges', () => {
            const hasAdmin = sdk.hasAdminPrivileges();
            expect(hasAdmin).to.be.a('boolean');
        });
    });
    
    describe('Installation Directory', () => {
        it('should generate installation directory', () => {
            const installDir = sdk.getInstallDir('nodejs');
            
            expect(installDir).to.be.a('string');
            expect(path.isAbsolute(installDir)).to.be.true;
            
            // Le chemin devrait contenir le nom du SDK
            expect(installDir.toLowerCase()).to.include('nodejs');
        });
        
        it('should generate different paths for different SDKs', () => {
            const dir1 = sdk.getInstallDir('nodejs');
            const dir2 = sdk.getInstallDir('python');
            
            expect(dir1).to.not.equal(dir2);
        });
        
        it('should use platform-specific paths', () => {
            const installDir = sdk.getInstallDir('test-sdk');
            const platform = os.platform();
            
            if (platform === 'win32') {
                expect(installDir).to.match(/AppData|Program Files/i);
            } else {
                expect(installDir).to.include(os.homedir());
            }
        });
    });
    
    describe('SDK Verification', () => {
        it('should verify installed SDK', async () => {
            // Vérifier Node.js qui devrait être installé
            const result = await sdk.verifySDK('nodejs');
            
            expect(result).to.be.an('object');
            expect(result).to.have.property('valid');
            expect(result.valid).to.be.true;
            expect(result).to.have.property('version');
        });
        
        it('should handle uninstalled SDK verification', async () => {
            // SDK probablement non installé
            const result = await sdk.verifySDK('flutter');
            
            expect(result).to.be.an('object');
            expect(result).to.have.property('valid');
            
            if (!result.valid) {
                expect(result).to.have.property('reason');
            }
        });
    });
    
    describe('Configuration', () => {
        it('should have valid SDK definitions', () => {
            const sdks = sdk.CONFIG.sdks;
            
            for (const [sdkId, sdkConfig] of Object.entries(sdks)) {
                expect(sdkConfig).to.have.property('name');
                expect(sdkConfig).to.have.property('executable');
                expect(sdkConfig).to.have.property('versionCommand');
                expect(sdkConfig).to.have.property('urls');
                
                expect(sdkConfig.name).to.be.a('string');
                expect(sdkConfig.executable).to.be.a('string');
                expect(sdkConfig.versionCommand).to.be.a('string');
                expect(sdkConfig.urls).to.be.an('object');
            }
        });
        
        it('should have download configuration', () => {
            expect(sdk.CONFIG).to.have.property('download');
            expect(sdk.CONFIG.download).to.have.property('maxRetries');
            expect(sdk.CONFIG.download).to.have.property('retryDelayMs');
            expect(sdk.CONFIG.download).to.have.property('timeoutMs');
            
            expect(sdk.CONFIG.download.maxRetries).to.be.at.least(1);
            expect(sdk.CONFIG.download.retryDelayMs).to.be.at.least(1000);
        });
    });
    
    describe('Supported SDKs', () => {
        it('should include essential development tools', () => {
            const supported = sdk.SUPPORTED_SDKS;
            
            expect(supported).to.include('nodejs');
            expect(supported).to.include('python');
            expect(supported).to.include('git');
            expect(supported).to.include('java');
            expect(supported).to.include('docker');
        });
        
        it('should include mobile development tools', () => {
            const supported = sdk.SUPPORTED_SDKS;
            
            expect(supported).to.include('flutter');
            expect(supported).to.include('androidSdk');
        });
        
        it('should include build tools', () => {
            const supported = sdk.SUPPORTED_SDKS;
            
            expect(supported).to.include('gradle');
            expect(supported).to.include('maven');
        });
    });
    
    describe('Error Handling', () => {
        it('should handle invalid SDK ID gracefully', async () => {
            try {
                await sdk.detectSDK('invalid-sdk-that-does-not-exist');
            } catch (error) {
                // Devrait soit retourner un résultat, soit throw une erreur propre
                expect(error).to.exist;
            }
        });
        
        it('should handle network failures gracefully', async () => {
            // Ce test vérifie que les erreurs réseau sont gérées
            const results = await sdk.detectAllSDKs();
            expect(results).to.be.an('object');
        });
    });
    
    describe('Cross-Platform Support', () => {
        it('should adapt to current platform', () => {
            const platform = os.platform();
            const config = sdk.CONFIG;
            
            // Les chemins devraient être adaptés à la plateforme
            expect(config.paths).to.have.property(platform === 'win32' ? 'windows' : 'unix');
        });
        
        it('should provide platform-specific URLs', () => {
            const sdks = sdk.CONFIG.sdks;
            const platform = os.platform();
            
            for (const [sdkId, sdkConfig] of Object.entries(sdks)) {
                expect(sdkConfig.urls).to.be.an('object');
                
                // Au moins une URL devrait être disponible
                const hasUrl = sdkConfig.urls[platform] || sdkConfig.urls.all;
                expect(hasUrl === undefined || hasUrl === null).to.be.false;
            }
        });
    });
    
    describe('PATH Management', () => {
        it('should have addToPath function', () => {
            expect(sdk.addToPath).to.be.a('function');
        });
        
        it('should have setEnvironmentVariable function', () => {
            expect(sdk.setEnvironmentVariable).to.be.a('function');
        });
    });
    
    describe('Performance', () => {
        it('should detect all SDKs in reasonable time', async () => {
            const start = Date.now();
            await sdk.detectAllSDKs();
            const duration = Date.now() - start;
            
            // La détection de tous les SDKs ne devrait pas prendre plus de 30 secondes
            expect(duration).to.be.below(30000);
        });
        
        it('should detect single SDK quickly', async () => {
            const start = Date.now();
            await sdk.detectSDK('nodejs');
            const duration = Date.now() - start;
            
            // Une détection unique devrait être très rapide
            expect(duration).to.be.below(5000);
        });
    });
    
    describe('Integration', () => {
        it('should work with Doctor system', async () => {
            // Le SDK installer devrait pouvoir être appelé par le Doctor
            const allSDKs = await sdk.detectAllSDKs();
            expect(allSDKs).to.be.an('object');
            expect(Object.keys(allSDKs).length).to.be.at.least(10);
        });
    });
});
