/**
 * ENTERPRISE TESTS - AUTO-FIX SYSTEM
 * 
 * Tests complets pour le système de réparation automatique
 */

const { expect } = require('chai');
const autofix = require('../../services/autofix.enterprise');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('🔧 Auto-Fix Enterprise - Tests', function() {
    this.timeout(60000); // 60 secondes pour tests de réparation
    
    describe('Module Exports', () => {
        it('should export main functions', () => {
            expect(autofix).to.have.property('autoFix');
            expect(autofix).to.have.property('diagnoseProject');
            expect(autofix).to.have.property('analyzeError');
            expect(autofix).to.have.property('detectErrorType');
            expect(autofix).to.have.property('createBackup');
            expect(autofix).to.have.property('restoreBackup');
        });
        
        it('should export specific fix functions', () => {
            expect(autofix).to.have.property('fixNpmMissingModule');
            expect(autofix).to.have.property('fixNpmPermissions');
            expect(autofix).to.have.property('cleanNpmInstallation');
            expect(autofix).to.have.property('fixNpmDependencyConflicts');
            expect(autofix).to.have.property('fixPythonMissingModule');
            expect(autofix).to.have.property('fixPipSSLErrors');
            expect(autofix).to.have.property('fixPortConflict');
        });
        
        it('should export CONFIG', () => {
            expect(autofix).to.have.property('CONFIG');
            expect(autofix.CONFIG).to.be.an('object');
            expect(autofix.CONFIG).to.have.property('backup');
            expect(autofix.CONFIG).to.have.property('npm');
            expect(autofix.CONFIG).to.have.property('python');
        });
    });
    
    describe('Error Pattern Detection', () => {
        it('should detect npm missing module error', () => {
            const errorMsg = "Error: Cannot find module 'express'";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            expect(patterns.length).to.be.at.least(1);
            
            const pattern = patterns.find(p => p.type === 'missing_module');
            expect(pattern).to.exist;
            expect(pattern.captured).to.equal('express');
        });
        
        it('should detect Python ModuleNotFoundError', () => {
            const errorMsg = "ModuleNotFoundError: No module named 'flask'";
            const patterns = autofix.analyzeError(errorMsg, 'python');
            
            expect(patterns).to.be.an('array');
            expect(patterns.length).to.be.at.least(1);
            
            const pattern = patterns.find(p => p.type === 'missing_module');
            expect(pattern).to.exist;
            expect(pattern.captured).to.equal('flask');
        });
        
        it('should detect ENOENT errors', () => {
            const errorMsg = "ENOENT: no such file or directory, open '/path/to/file'";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'missing_file');
            expect(pattern).to.exist;
        });
        
        it('should detect permission errors', () => {
            const errorMsg = "EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'permission_error');
            expect(pattern).to.exist;
        });
        
        it('should detect lockfile sync errors', () => {
            const errorMsg = "npm ERR! package-lock.json out of sync with package.json";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'lockfile_sync');
            expect(pattern).to.exist;
        });
        
        it('should detect dependency conflicts', () => {
            const errorMsg = "npm ERR! Unable to resolve dependency tree";
            const patterns = autofix.analyzeError(errorMsg, 'npm');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'dependency_conflict');
            expect(pattern).to.exist;
        });
        
        it('should detect port conflicts', () => {
            const errorMsg = "Error: listen EADDRINUSE: address already in use :::3000";
            const patterns = autofix.analyzeError(errorMsg, 'general');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'port_conflict');
            expect(pattern).to.exist;
        });
        
        it('should detect pip SSL errors', () => {
            const errorMsg = "pip is configured with locations that require TLS/SSL";
            const patterns = autofix.analyzeError(errorMsg, 'python');
            
            expect(patterns).to.be.an('array');
            const pattern = patterns.find(p => p.type === 'ssl_error');
            expect(pattern).to.exist;
        });
    });
    
    describe('Error Type Detection', () => {
        it('should detect npm errors', () => {
            const errorMsg = "npm ERR! code ELIFECYCLE";
            const type = autofix.detectErrorType(errorMsg);
            expect(type).to.equal('npm');
        });
        
        it('should detect Python errors', () => {
            const errorMsg = "ModuleNotFoundError: No module named 'requests'";
            const type = autofix.detectErrorType(errorMsg);
            expect(type).to.equal('python');
        });
        
        it('should detect pip errors', () => {
            const errorMsg = "pip install failed with error";
            const type = autofix.detectErrorType(errorMsg);
            expect(type).to.equal('python');
        });
        
        it('should return general for unknown errors', () => {
            const errorMsg = "Some random error message";
            const type = autofix.detectErrorType(errorMsg);
            expect(type).to.equal('general');
        });
    });
    
    describe('Backup System', () => {
        it('should create backup', async () => {
            const testDir = path.join(os.tmpdir(), 'autofix-test-' + Date.now());
            const testFile = path.join(testDir, 'test.txt');
            
            try {
                // Créer un fichier de test
                await fs.mkdir(testDir, { recursive: true });
                await fs.writeFile(testFile, 'test content');
                
                // Créer un backup
                const backup = await autofix.createBackup(testFile, 'test-backup');
                
                expect(backup).to.be.an('object');
                expect(backup).to.have.property('id');
                expect(backup).to.have.property('originalPath');
                expect(backup).to.have.property('backupPath');
                expect(backup).to.have.property('timestamp');
                
                // Vérifier que le backup existe
                const backupExists = await fs.access(backup.backupPath)
                    .then(() => true)
                    .catch(() => false);
                expect(backupExists).to.be.true;
                
            } finally {
                // Cleanup
                try {
                    await fs.rm(testDir, { recursive: true, force: true });
                } catch {}
            }
        });
        
        it('should restore backup', async () => {
            const testDir = path.join(os.tmpdir(), 'autofix-test-' + Date.now());
            const testFile = path.join(testDir, 'test.txt');
            const originalContent = 'original content';
            const modifiedContent = 'modified content';
            
            try {
                // Créer un fichier
                await fs.mkdir(testDir, { recursive: true });
                await fs.writeFile(testFile, originalContent);
                
                // Créer backup
                const backup = await autofix.createBackup(testFile, 'test-restore');
                
                // Modifier le fichier
                await fs.writeFile(testFile, modifiedContent);
                
                // Vérifier modification
                let content = await fs.readFile(testFile, 'utf8');
                expect(content).to.equal(modifiedContent);
                
                // Restaurer backup
                await autofix.restoreBackup(backup);
                
                // Vérifier restauration
                content = await fs.readFile(testFile, 'utf8');
                expect(content).to.equal(originalContent);
                
            } finally {
                // Cleanup
                try {
                    await fs.rm(testDir, { recursive: true, force: true });
                } catch {}
            }
        });
    });
    
    describe('Project Diagnosis', () => {
        it('should diagnose project', async () => {
            // Utiliser le répertoire courant pour le diagnostic
            const diagnosis = await autofix.diagnoseProject(process.cwd());
            
            expect(diagnosis).to.be.an('object');
            expect(diagnosis).to.have.property('issues');
            expect(diagnosis).to.have.property('healthy');
            expect(diagnosis).to.have.property('summary');
            
            expect(diagnosis.issues).to.be.an('array');
            expect(diagnosis.healthy).to.be.a('boolean');
            expect(diagnosis.summary).to.be.an('object');
        });
        
        it('should detect missing dependencies', async () => {
            const testDir = path.join(os.tmpdir(), 'autofix-test-project-' + Date.now());
            
            try {
                // Créer un projet de test avec package.json mais sans node_modules
                await fs.mkdir(testDir, { recursive: true });
                await fs.writeFile(
                    path.join(testDir, 'package.json'),
                    JSON.stringify({ name: 'test', version: '1.0.0' })
                );
                
                const diagnosis = await autofix.diagnoseProject(testDir);
                
                expect(diagnosis.issues).to.be.an('array');
                // Devrait détecter l'absence de node_modules
                const missingDeps = diagnosis.issues.find(i => i.type === 'missing_dependencies');
                expect(missingDeps).to.exist;
                
            } finally {
                // Cleanup
                try {
                    await fs.rm(testDir, { recursive: true, force: true });
                } catch {}
            }
        });
    });
    
    describe('Configuration', () => {
        it('should have backup configuration', () => {
            expect(autofix.CONFIG.backup).to.be.an('object');
            expect(autofix.CONFIG.backup).to.have.property('enabled');
            expect(autofix.CONFIG.backup).to.have.property('directory');
            expect(autofix.CONFIG.backup).to.have.property('maxBackups');
            expect(autofix.CONFIG.backup).to.have.property('retentionDays');
        });
        
        it('should have npm configuration', () => {
            expect(autofix.CONFIG.npm).to.be.an('object');
            expect(autofix.CONFIG.npm).to.have.property('cacheDir');
            expect(autofix.CONFIG.npm).to.have.property('configFiles');
            expect(autofix.CONFIG.npm.configFiles).to.be.an('array');
        });
        
        it('should have Python configuration', () => {
            expect(autofix.CONFIG.python).to.be.an('object');
            expect(autofix.CONFIG.python).to.have.property('cacheDir');
            expect(autofix.CONFIG.python).to.have.property('configFiles');
            expect(autofix.CONFIG.python.configFiles).to.be.an('array');
        });
        
        it('should have timeout configuration', () => {
            expect(autofix.CONFIG.timeout).to.be.an('object');
            expect(autofix.CONFIG.timeout).to.have.property('install');
            expect(autofix.CONFIG.timeout).to.have.property('diagnosis');
            
            expect(autofix.CONFIG.timeout.install).to.be.a('number');
            expect(autofix.CONFIG.timeout.diagnosis).to.be.a('number');
        });
    });
    
    describe('Error Handling', () => {
        it('should handle invalid project path', async () => {
            try {
                const diagnosis = await autofix.diagnoseProject('/invalid/path/that/does/not/exist');
                // Devrait retourner un résultat vide ou erreur gracieuse
                expect(diagnosis).to.exist;
            } catch (error) {
                // Si erreur, elle devrait être propre
                expect(error).to.have.property('message');
            }
        });
        
        it('should handle backup of non-existent file', async () => {
            const backup = await autofix.createBackup('/non/existent/file', 'test');
            // Devrait retourner null ou gérer gracieusement
            expect(backup === null || backup === undefined).to.be.true;
        });
    });
    
    describe('Performance', () => {
        it('should diagnose project quickly', async () => {
            const start = Date.now();
            await autofix.diagnoseProject(process.cwd());
            const duration = Date.now() - start;
            
            // Le diagnostic ne devrait pas prendre plus de 10 secondes
            expect(duration).to.be.below(10000);
        });
        
        it('should analyze errors quickly', () => {
            const start = Date.now();
            
            for (let i = 0; i < 100; i++) {
                autofix.analyzeError("Cannot find module 'test'", 'npm');
            }
            
            const duration = Date.now() - start;
            
            // 100 analyses devraient être très rapides
            expect(duration).to.be.below(1000);
        });
    });
    
    describe('Integration', () => {
        it('should work with Doctor system', async () => {
            // L'auto-fix devrait pouvoir analyser les résultats du Doctor
            const diagnosis = await autofix.diagnoseProject(process.cwd());
            expect(diagnosis).to.be.an('object');
            expect(diagnosis).to.have.property('issues');
        });
        
        it('should work with SDK installer', async () => {
            // L'auto-fix devrait pouvoir détecter les problèmes d'SDK
            const errorMsg = "python: command not found";
            const type = autofix.detectErrorType(errorMsg);
            expect(type).to.be.a('string');
        });
    });
});
