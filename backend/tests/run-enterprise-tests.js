/**
 * ENTERPRISE TEST SUITE - RUNNER
 * 
 * Main test runner for all enterprise tests
 */

const Mocha = require('mocha');
const path = require('path');
const fs = require('fs');

// Configuration Mocha
const mocha = new Mocha({
    timeout: 60000, // 60 secondes global timeout
    reporter: 'spec',
    color: true,
    bail: false, // Continue même si un test fail
    slow: 5000, // Tests lents > 5s
});

// Collecter tous les fichiers de test
const testDirectories = [
    path.join(__dirname, 'enterprise'),
    path.join(__dirname, 'integration'),
    path.join(__dirname, 'unit'),
];

console.log('🧪 SUDO STUDIO - ENTERPRISE TEST SUITE');
console.log('=' .repeat(60));
console.log('');

let totalFiles = 0;

testDirectories.forEach(dir => {
    if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
            .filter(file => file.endsWith('.test.js'))
            .map(file => path.join(dir, file));
        
        files.forEach(file => {
            mocha.addFile(file);
            totalFiles++;
            console.log(`✓ Loaded: ${path.relative(__dirname, file)}`);
        });
    }
});

console.log('');
console.log(`📋 Total test files: ${totalFiles}`);
console.log('=' .repeat(60));
console.log('');

// Exécuter les tests
mocha.run((failures) => {
    console.log('');
    console.log('=' .repeat(60));
    
    if (failures) {
        console.log(`❌ Tests failed: ${failures} failure(s)`);
        process.exit(1);
    } else {
        console.log('✅ All tests passed!');
        console.log('');
        console.log('🎉 SUDO STUDIO ENTERPRISE - TESTS COMPLETE');
        process.exit(0);
    }
});
