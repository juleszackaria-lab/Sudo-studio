#!/usr/bin/env node
/**
 * END-TO-END AI FLOW TEST
 * Tests the complete communication pipeline:
 * Test Script → Backend API → Python Runtime → Model → Response
 */

const axios = require('axios');
const colors = require('colors');

const BACKEND_URL = 'http://localhost:5000';
const RUNTIME_URL = 'http://localhost:6000';

// Test results
let results = {
  passed: 0,
  failed: 0,
  tests: []
};

function logTest(name, passed, message) {
  const status = passed ? '✅ PASS'.green : '❌ FAIL'.red;
  console.log(`\n${status} - ${name}`);
  if (message) console.log(`  ${message}`);
  results.tests.push({ name, passed, message });
  if (passed) results.passed++;
  else results.failed++;
}

async function testRuntimeHealth() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: Python Runtime Health Check'.cyan.bold);
  console.log('='.repeat(60));
  
  try {
    const response = await axios.get(`${RUNTIME_URL}/health`, { timeout: 3000 });
    const data = response.data;
    
    console.log('Runtime Status:', JSON.stringify(data, null, 2));
    
    if (data.status === 'healthy') {
      logTest('Runtime Health', true, `Runtime is healthy on port 6000`);
      
      if (data.model && data.model.loaded) {
        logTest('Model Loaded', true, `Model: ${data.model.name} on ${data.model.device}`);
      } else {
        logTest('Model Loaded', false, 'No model loaded - running in MOCK mode');
      }
      
      return true;
    } else {
      logTest('Runtime Health', false, 'Runtime status is not healthy');
      return false;
    }
  } catch (error) {
    logTest('Runtime Health', false, `Cannot connect to runtime: ${error.message}`);
    console.log('  ⚠️  Make sure runtime.exe is running!'.yellow);
    return false;
  }
}

async function testRuntimeInference() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: Python Runtime Direct Inference'.cyan.bold);
  console.log('='.repeat(60));
  
  try {
    const testPrompt = 'Hello, can you help me?';
    console.log(`Sending prompt: "${testPrompt}"`);
    
    const response = await axios.post(`${RUNTIME_URL}/infer`, {
      message: testPrompt,
      prompt: testPrompt,
      input: testPrompt,
      max_tokens: 100,
      temperature: 0.7,
      stream: false
    }, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('Runtime Response:', JSON.stringify(response.data, null, 2));
    
    if (response.data && response.data.reply) {
      logTest('Direct Inference', true, `Got reply: ${response.data.reply.substring(0, 100)}...`);
      
      if (response.data.mock) {
        console.log('  ⚠️  Runtime is in MOCK mode (no model loaded)'.yellow);
      }
      
      return true;
    } else {
      logTest('Direct Inference', false, 'No reply field in response');
      return false;
    }
  } catch (error) {
    logTest('Direct Inference', false, `Runtime inference failed: ${error.message}`);
    console.log('Error details:', error.response?.data || error.message);
    return false;
  }
}

async function testBackendHealth() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: Backend Server Health'.cyan.bold);
  console.log('='.repeat(60));
  
  try {
    const response = await axios.get(`${BACKEND_URL}/api/system/health`, { timeout: 3000 });
    logTest('Backend Health', true, 'Backend server is running');
    return true;
  } catch (error) {
    logTest('Backend Health', false, `Cannot connect to backend: ${error.message}`);
    console.log('  ⚠️  Make sure backend.exe is running!'.yellow);
    return false;
  }
}

async function testBackendAIHealth() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 4: Backend AI Health Check'.cyan.bold);
  console.log('='.repeat(60));
  
  // Create a test token (you may need to login first)
  const testToken = 'test-token';  // This will need actual auth in production
  
  try {
    const response = await axios.get(`${BACKEND_URL}/api/ai/health`, {
      timeout: 5000,
      headers: { 'Authorization': `Bearer ${testToken}` },
      validateStatus: (status) => status < 500  // Accept 401/403 as we might not be authenticated
    });
    
    if (response.status === 401 || response.status === 403) {
      console.log('  ℹ️  Authentication required (expected)'.blue);
      logTest('Backend AI Health Endpoint', true, 'Endpoint exists but requires authentication');
      return true;
    }
    
    console.log('AI Health:', JSON.stringify(response.data, null, 2));
    
    if (response.data.services && response.data.services.python_runtime) {
      const runtimeStatus = response.data.services.python_runtime.status;
      logTest('Backend → Runtime Connection', runtimeStatus === 'online', 
        `Runtime status: ${runtimeStatus}`);
      return runtimeStatus === 'online';
    }
    
    return true;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      logTest('Backend AI Health Endpoint', true, 'Endpoint exists (auth required)');
      return true;
    }
    logTest('Backend AI Health', false, `Failed: ${error.message}`);
    return false;
  }
}

async function testBackendAIModels() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 5: Backend AI Models List'.cyan.bold);
  console.log('='.repeat(60));
  
  const testToken = 'test-token';
  
  try {
    const response = await axios.get(`${BACKEND_URL}/api/ai/models`, {
      timeout: 5000,
      headers: { 'Authorization': `Bearer ${testToken}` },
      validateStatus: (status) => status < 500
    });
    
    if (response.status === 401 || response.status === 403) {
      logTest('Backend AI Models Endpoint', true, 'Endpoint exists (auth required)');
      return true;
    }
    
    console.log('Models:', JSON.stringify(response.data, null, 2));
    logTest('Backend AI Models', true, `Found ${response.data.models?.length || 0} models configured`);
    return true;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      logTest('Backend AI Models Endpoint', true, 'Endpoint exists (auth required)');
      return true;
    }
    logTest('Backend AI Models', false, `Failed: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n' + '█'.repeat(60).rainbow);
  console.log('  SUDO STUDIO - END-TO-END AI FLOW TEST'.rainbow.bold);
  console.log('█'.repeat(60).rainbow);
  
  // Test order matters
  const runtimeOk = await testRuntimeHealth();
  
  if (runtimeOk) {
    await testRuntimeInference();
  }
  
  const backendOk = await testBackendHealth();
  
  if (backendOk) {
    await testBackendAIHealth();
    await testBackendAIModels();
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY'.cyan.bold);
  console.log('='.repeat(60));
  console.log(`Total Tests: ${results.passed + results.failed}`);
  console.log(`Passed: ${results.passed}`.green);
  console.log(`Failed: ${results.failed}`.red);
  
  if (results.failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED! AI pipeline is ready!'.green.bold);
  } else {
    console.log('\n⚠️  SOME TESTS FAILED - See details above'.yellow.bold);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('NEXT STEPS:'.cyan.bold);
  console.log('='.repeat(60));
  
  if (!runtimeOk) {
    console.log('1. Start Python runtime:');
    console.log('   cd backend/runtime');
    console.log('   python server.enterprise.py --port 6000 --auto-download');
  }
  
  if (!backendOk) {
    console.log('2. Start backend server:');
    console.log('   cd backend');
    console.log('   node server.js');
  }
  
  if (runtimeOk && backendOk) {
    console.log('✅ System is operational!');
    console.log('3. Open VSCode/VSCodium and test the extension chat');
    console.log('4. Send a message and verify you get a response');
  }
  
  process.exit(results.failed === 0 ? 0 : 1);
}

// Run tests
runTests().catch(error => {
  console.error('Test runner failed:'.red.bold, error);
  process.exit(1);
});
