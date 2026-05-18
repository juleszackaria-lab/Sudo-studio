/**
 * INTEGRATION TESTS - COMPLETE SYSTEM
 * 
 * Tests d'intégration pour valider l'ensemble du système
 */

const { expect } = require('chai');
const doctor = require('../../doctor/environmentDoctor.enterprise');
const sdk = require('../../installers/sdkInstaller.enterprise');
const autofix = require('../../services/autofix.enterprise');

describe('🔗 Integration Tests - Complete System', function() {
    this.timeout(120000); // 2 minutes pour tests d'intégration
    
    describe('Doctor → SDK Installer Integration', () => {
        it('should detect SDKs and installer should confirm', async () => {
            // Le Doctor détecte les SDKs
            const doctorSDKs = await doctor.checkSDKs();
            
            // Le SDK Installer devrait confirmer la même chose
            const installerSDKs = await sdk.detectAllSDKs();
            
            // Vérifier cohérence pour Node.js
            const doctorNodejs = doctorSDKs.nodejs;
            const installerNodejs = installerSDKs.nodejs;
            
            expect(doctorNodejs.installed).to.equal(installerNodejs.installed);
            
            if (doctorNodejs.installed && installerNodejs.installed) {
                // Les versions devraient être similaires
                expect(doctorNodejs.version).to.be.a('string');
                expect(installerNodejs.version).to.be.a('string');
            }
        });
        
        it('should provide installation recommendations', async () => {
            const diagnosis = await doctor.diagnose();
            const sdkResults = await sdk.detectAllSDKs();
            
            // Si le Doctor recommande une installation, l'installer doit pouvoir la fournir
            if (diagnosis.recommendations.some(r => r.includes('install'))) {
                expect(sdk.SUPPORTED_SDKS).to.be.an('array');
                expect(sdk.SUPPORTED_SDKS.length).to.be.at.least(10);
            }
        });
    });
    
    describe('Doctor → Auto-fix Integration', () => {
        it('should diagnose and provide fixable issues', async () => {
            const doctorDiagnosis = await doctor.diagnose();
            const autofixDiagnosis = await autofix.diagnoseProject(process.cwd());
            
            // Les deux systèmes devraient détecter des problèmes similaires
            expect(doctorDiagnosis).to.be.an('object');
            expect(autofixDiagnosis).to.be.an('object');
            
            expect(autofixDiagnosis).to.have.property('issues');
            expect(autofixDiagnosis.issues).to.be.an('array');
        });
        
        it('should detect PATH issues consistently', async () => {
            const pathAnalysis = await doctor.analyzePath();
            
            // L'auto-fix devrait pouvoir réparer les problèmes de PATH
            if (pathAnalysis.invalid && pathAnalysis.invalid.length > 0) {
                // Test que l'auto-fix a des fonctions pour réparer PATH
                expect(autofix.analyzeError).to.be.a('function');
            }
        });
    });
    
    describe('SDK Installer → Auto-fix Integration', () => {
        it('should handle installation errors', async () => {
            // Simuler une erreur d'installation
            const errorMsg = "Failed to install Node.js: permission denied";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            
            // L'auto-fix devrait détecter le problème de permission
            const permissionPattern = patterns.find(p => p.type === 'permission_error');
            expect(permissionPattern).to.exist;
        });
        
        it('should detect missing SDKs and suggest fixes', async () => {
            const sdkResults = await sdk.detectAllSDKs();
            
            // Compter les SDKs non installés
            const missingSDKs = Object.entries(sdkResults)
                .filter(([_, info]) => !info.installed)
                .map(([id, _]) => id);
            
            // L'auto-fix devrait pouvoir diagnostiquer ces manques
            const diagnosis = await autofix.diagnoseProject(process.cwd());
            expect(diagnosis).to.have.property('issues');
        });
    });
    
    describe('Complete Workflow', () => {
        it('should run complete diagnostic workflow', async () => {
            console.log('      Running complete diagnostic workflow...');
            
            // 1. Doctor détecte l'état du système
            const doctorResults = await doctor.diagnose();
            expect(doctorResults).to.have.property('score');
            console.log(`      ✓ Doctor score: ${doctorResults.score}/100`);
            
            // 2. SDK Installer vérifie les SDKs
            const sdkResults = await sdk.detectAllSDKs();
            const installedCount = Object.values(sdkResults)
                .filter(sdk => sdk.installed).length;
            console.log(`      ✓ SDKs detected: ${installedCount}/${Object.keys(sdkResults).length}`);
            
            // 3. Auto-fix analyse les problèmes
            const autofixResults = await autofix.diagnoseProject(process.cwd());
            console.log(`      ✓ Issues found: ${autofixResults.issues.length}`);
            
            // Tous les systèmes devraient fonctionner ensemble
            expect(doctorResults).to.be.an('object');
            expect(sdkResults).to.be.an('object');
            expect(autofixResults).to.be.an('object');
        });
        
        it('should provide coherent recommendations', async () => {
            const doctorResults = await doctor.diagnose();
            const autofixResults = await autofix.diagnoseProject(process.cwd());
            
            // Les recommandations devraient être cohérentes
            expect(doctorResults.recommendations).to.be.an('array');
            expect(autofixResults.issues).to.be.an('array');
            
            // Si le Doctor détecte un problème, l'auto-fix devrait le voir aussi
            if (doctorResults.score < 100) {
                // Il devrait y avoir soit des recommandations Doctor, soit des issues autofix
                const hasIssues = doctorResults.recommendations.length > 0 || 
                                 autofixResults.issues.length > 0;
                expect(hasIssues).to.be.true;
            }
        });
    });
    
    describe('Performance - End to End', () => {
        it('should complete full system check in reasonable time', async () => {
            const start = Date.now();
            
            // Exécuter tous les systèmes en parallèle
            await Promise.all([
                doctor.diagnose(),
                sdk.detectAllSDKs(),
                autofix.diagnoseProject(process.cwd())
            ]);
            
            const duration = Date.now() - start;
            
            console.log(`      ✓ Full system check completed in ${(duration / 1000).toFixed(2)}s`);
            
            // Le check complet ne devrait pas prendre plus de 60 secondes
            expect(duration).to.be.below(60000);
        });
        
        it('should handle concurrent checks', async () => {
            // Exécuter plusieurs checks en parallèle
            const checks = [];
            for (let i = 0; i < 3; i++) {
                checks.push(doctor.checkSDKs());
                checks.push(sdk.detectSDK('nodejs'));
            }
            
            const results = await Promise.all(checks);
            
            // Tous les checks devraient réussir
            expect(results.length).to.equal(6);
            results.forEach(result => {
                expect(result).to.exist;
            });
        });
    });
    
    describe('Error Recovery', () => {
        it('should handle network failures gracefully', async () => {
            // Simuler des conditions de réseau difficiles
            const networkCheck = await doctor.checkNetwork();
            
            // Même en cas d'échec réseau, le système devrait continuer
            expect(networkCheck).to.be.an('object');
        });
        
        it('should continue after component failure', async () => {
            try {
                // Forcer une erreur dans un composant
                await autofix.diagnoseProject('/invalid/path');
            } catch (error) {
                // Le système devrait gérer l'erreur
            }
            
            // Les autres composants devraient toujours fonctionner
            const sdkResults = await sdk.detectSDK('nodejs');
            expect(sdkResults).to.be.an('object');
        });
    });
    
    describe('Data Consistency', () => {
        it('should maintain consistent data across systems', async () => {
            // Exécuter les trois systèmes
            const doctorData = await doctor.diagnose();
            const sdkData = await sdk.detectAllSDKs();
            const autofixData = await autofix.diagnoseProject(process.cwd());
            
            // Vérifier que les données sont cohérentes
            // Ex: Si Doctor dit Node.js installé, SDK doit confirmer
            if (doctorData.sdks && doctorData.sdks.nodejs) {
                expect(doctorData.sdks.nodejs.installed)
                    .to.equal(sdkData.nodejs.installed);
            }
        });
        
        it('should provide timestamps', async () => {
            const doctorData = await doctor.diagnose();
            
            expect(doctorData).to.have.property('timestamp');
            expect(doctorData.timestamp).to.be.a('string');
            
            // Le timestamp devrait être récent (moins de 1 minute)
            const timestamp = new Date(doctorData.timestamp);
            const now = new Date();
            const diff = now - timestamp;
            
            expect(diff).to.be.below(60000); // Moins de 60 secondes
        });
    });
});
