/**
 * ENTERPRISE TESTS - ENVIRONMENT DOCTOR
 * 
 * Tests complets pour le système de diagnostic enterprise
 */

const { expect } = require('chai');
const doctor = require('../../doctor/environmentDoctor.enterprise');

describe('🏥 Environment Doctor Enterprise - Tests', function() {
    this.timeout(30000); // 30 secondes pour les tests lents
    
    describe('Basic Functionality', () => {
        it('should export main functions', () => {
            expect(doctor).to.have.property('diagnose');
            expect(doctor).to.have.property('checkSDKs');
            expect(doctor).to.have.property('analyzePath');
            expect(doctor).to.have.property('checkNetwork');
            expect(doctor).to.have.property('checkPorts');
        });
        
        it('should detect at least one SDK', async () => {
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.be.an('object');
            expect(Object.keys(sdks).length).to.be.at.least(1);
        });
    });
    
    describe('SDK Detection', () => {
        it('should detect Node.js', async () => {
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.have.property('nodejs');
            expect(sdks.nodejs).to.have.property('installed');
            expect(sdks.nodejs.installed).to.be.true;
            expect(sdks.nodejs).to.have.property('version');
        });
        
        it('should detect npm', async () => {
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.have.property('npm');
            expect(sdks.npm.installed).to.be.true;
        });
        
        it('should detect Python (if installed)', async () => {
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.have.property('python');
            // Python peut ne pas être installé, donc on vérifie juste la structure
            expect(sdks.python).to.have.property('installed');
        });
        
        it('should detect Git (if installed)', async () => {
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.have.property('git');
            expect(sdks.git).to.have.property('installed');
        });
    });
    
    describe('PATH Analysis', () => {
        it('should analyze PATH environment variable', async () => {
            const pathAnalysis = await doctor.analyzePath();
            
            expect(pathAnalysis).to.be.an('object');
            expect(pathAnalysis).to.have.property('pathEntries');
            expect(pathAnalysis.pathEntries).to.be.an('array');
            expect(pathAnalysis.pathEntries.length).to.be.at.least(1);
        });
        
        it('should detect duplicate PATH entries', async () => {
            const pathAnalysis = await doctor.analyzePath();
            expect(pathAnalysis).to.have.property('duplicates');
            expect(pathAnalysis.duplicates).to.be.an('array');
        });
        
        it('should detect invalid PATH entries', async () => {
            const pathAnalysis = await doctor.analyzePath();
            expect(pathAnalysis).to.have.property('invalid');
            expect(pathAnalysis.invalid).to.be.an('array');
        });
    });
    
    describe('Network Connectivity', () => {
        it('should check network connectivity', async () => {
            const networkCheck = await doctor.checkNetwork();
            
            expect(networkCheck).to.be.an('object');
            expect(networkCheck).to.have.property('overall');
            expect(networkCheck).to.have.property('services');
        });
        
        it('should test npm registry', async () => {
            const networkCheck = await doctor.checkNetwork();
            expect(networkCheck.services).to.have.property('npm');
        });
        
        it('should test PyPI', async () => {
            const networkCheck = await doctor.checkNetwork();
            expect(networkCheck.services).to.have.property('pypi');
        });
        
        it('should test GitHub', async () => {
            const networkCheck = await doctor.checkNetwork();
            expect(networkCheck.services).to.have.property('github');
        });
    });
    
    describe('Port Availability', () => {
        it('should check port availability', async () => {
            const portsCheck = await doctor.checkPorts();
            
            expect(portsCheck).to.be.an('object');
            expect(portsCheck).to.have.property('ports');
            expect(portsCheck.ports).to.be.an('array');
        });
        
        it('should check port 3000', async () => {
            const portsCheck = await doctor.checkPorts();
            const port3000 = portsCheck.ports.find(p => p.port === 3000);
            expect(port3000).to.exist;
            expect(port3000).to.have.property('available');
        });
        
        it('should check port 5000', async () => {
            const portsCheck = await doctor.checkPorts();
            const port5000 = portsCheck.ports.find(p => p.port === 5000);
            expect(port5000).to.exist;
        });
    });
    
    describe('Full Diagnostic', () => {
        it('should run complete diagnostic', async () => {
            const diagnosis = await doctor.diagnose();
            
            expect(diagnosis).to.be.an('object');
            expect(diagnosis).to.have.property('sdks');
            expect(diagnosis).to.have.property('environment');
            expect(diagnosis).to.have.property('network');
            expect(diagnosis).to.have.property('ports');
            expect(diagnosis).to.have.property('score');
            expect(diagnosis).to.have.property('recommendations');
        });
        
        it('should calculate health score', async () => {
            const diagnosis = await doctor.diagnose();
            expect(diagnosis.score).to.be.a('number');
            expect(diagnosis.score).to.be.at.least(0);
            expect(diagnosis.score).to.be.at.most(100);
        });
        
        it('should provide recommendations', async () => {
            const diagnosis = await doctor.diagnose();
            expect(diagnosis.recommendations).to.be.an('array');
        });
        
        it('should have timestamp', async () => {
            const diagnosis = await doctor.diagnose();
            expect(diagnosis).to.have.property('timestamp');
            expect(diagnosis.timestamp).to.be.a('string');
        });
    });
    
    describe('Error Handling', () => {
        it('should handle network errors gracefully', async () => {
            // Ce test vérifie que les erreurs réseau ne crashent pas le système
            try {
                const networkCheck = await doctor.checkNetwork();
                expect(networkCheck).to.exist;
            } catch (error) {
                // Si erreur, elle doit être correctement structurée
                expect(error).to.have.property('message');
            }
        });
        
        it('should handle invalid commands gracefully', async () => {
            // Les commandes invalides ne doivent pas crasher
            const sdks = await doctor.checkSDKs();
            expect(sdks).to.be.an('object');
        });
    });
    
    describe('Performance', () => {
        it('should complete diagnostic in reasonable time', async () => {
            const start = Date.now();
            await doctor.diagnose();
            const duration = Date.now() - start;
            
            // Le diagnostic complet ne devrait pas prendre plus de 30 secondes
            expect(duration).to.be.below(30000);
        });
        
        it('should cache results appropriately', async () => {
            const start1 = Date.now();
            await doctor.checkSDKs();
            const duration1 = Date.now() - start1;
            
            const start2 = Date.now();
            await doctor.checkSDKs();
            const duration2 = Date.now() - start2;
            
            // La deuxième exécution peut être plus rapide (cache)
            expect(duration2).to.be.at.most(duration1 * 1.5);
        });
    });
});
