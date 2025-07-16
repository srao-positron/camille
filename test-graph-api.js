#!/usr/bin/env node

// Test script to check if the API server is working

const PORT = 3456;

async function testAPI() {
  console.log(`Testing API server on port ${PORT}...`);
  
  try {
    // Wait a bit for any startup issues
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test health endpoint
    console.log('\n1. Testing health endpoint:');
    const healthResponse = await fetch(`http://localhost:${PORT}/api/health`);
    if (healthResponse.ok) {
      const health = await healthResponse.json();
      console.log('✓ Health check:', health);
    } else {
      console.log('✗ Health check failed:', healthResponse.status, healthResponse.statusText);
    }
    
    // Test status endpoint
    console.log('\n2. Testing status endpoint:');
    const statusResponse = await fetch(`http://localhost:${PORT}/api/status`);
    if (statusResponse.ok) {
      const status = await statusResponse.json();
      console.log('✓ Server status:', JSON.stringify(status, null, 2));
    } else {
      console.log('✗ Status check failed:', statusResponse.status, statusResponse.statusText);
    }
    
    // Test graph stats endpoint
    console.log('\n3. Testing graph stats endpoint:');
    const statsResponse = await fetch(`http://localhost:${PORT}/api/graph/stats`);
    if (statsResponse.ok) {
      const stats = await statsResponse.json();
      console.log('✓ Graph statistics:');
      console.log(`  - Total nodes: ${stats.nodeCount}`);
      console.log(`  - Total edges: ${stats.edgeCount}`);
      console.log(`  - Database ready: ${stats.ready}`);
      
      if (stats.nodeTypes && stats.nodeTypes.length > 0) {
        console.log('\n  Node types:');
        stats.nodeTypes.forEach(nt => {
          console.log(`    - ${nt.type}: ${nt.count}`);
        });
      }
      
      if (stats.edgeTypes && stats.edgeTypes.length > 0) {
        console.log('\n  Edge types:');
        stats.edgeTypes.forEach(et => {
          console.log(`    - ${et.type}: ${et.count}`);
        });
      }
    } else {
      console.log('✗ Graph stats failed:', statsResponse.status, statsResponse.statusText);
    }
    
    // Test graph query endpoint
    console.log('\n4. Testing graph query endpoint:');
    const queryResponse = await fetch(`http://localhost:${PORT}/api/graph/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'MATCH ()-[r]->() RETURN COUNT(r) as edgeCount LIMIT 1'
      })
    });
    
    if (queryResponse.ok) {
      const result = await queryResponse.json();
      console.log('✓ Query result:', result);
    } else {
      console.log('✗ Query failed:', queryResponse.status, queryResponse.statusText);
    }
    
  } catch (error) {
    console.error('\nError:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('\nThe API server is not running on port', PORT);
      console.log('This might be because:');
      console.log('1. The API server failed to start');
      console.log('2. It is running on a different port');
      console.log('3. There was an error during server startup');
      console.log('\nCheck the logs at: ~/.camille/logs/camille.log');
    }
  }
}

testAPI().catch(console.error);