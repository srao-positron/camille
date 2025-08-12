#!/usr/bin/env node

const { KuzuGraphDB } = require('./dist/memory/databases/kuzu-db.js');

async function checkEdgeCount() {
  console.log('Checking edge count in Kuzu graph database...\n');
  
  // Wait a bit for any locks to clear
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const db = new KuzuGraphDB();
  
  try {
    await db.connect();
    console.log('✓ Connected to graph database\n');
    
    // Simple edge count query
    console.log('Running query: MATCH ()-[r]->() RETURN COUNT(r) as edgeCount');
    const result = await db.query('MATCH ()-[r]->() RETURN COUNT(r) as edgeCount');
    
    if (result && result.length > 0) {
      console.log('\n✓ Query successful!');
      console.log(`Total edges in graph: ${JSON.stringify(result[0].edgeCount || result[0])}`);
    } else {
      console.log('\n✗ No results returned');
    }
    
    // Also check node count for comparison
    console.log('\nRunning query: MATCH (n) RETURN COUNT(n) as nodeCount');
    const nodeResult = await db.query('MATCH (n) RETURN COUNT(n) as nodeCount');
    if (nodeResult && nodeResult.length > 0) {
      console.log(`Total nodes in graph: ${JSON.stringify(nodeResult[0].nodeCount || nodeResult[0])}`);
    }
    
    // Sample some edges if they exist
    console.log('\nRunning query: MATCH (a)-[r]->(b) RETURN a.name as source, type(r) as relType, b.name as target LIMIT 5');
    const sampleEdges = await db.query('MATCH (a)-[r]->(b) RETURN a.name as source, type(r) as relType, b.name as target LIMIT 5');
    if (sampleEdges && sampleEdges.length > 0) {
      console.log('\nSample edges:');
      sampleEdges.forEach((edge, i) => {
        console.log(`${i+1}. ${edge.source} --[${edge.relType}]--> ${edge.target}`);
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.message.includes('lock')) {
      console.log('\nThe database is locked by another process (likely the Camille server).');
      console.log('This is expected behavior - the server maintains exclusive access to the graph database.');
      console.log('\nTo check edges, you should use the graph_query MCP tool through Claude Code instead.');
    }
  } finally {
    try {
      await db.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }
  }
}

checkEdgeCount().catch(console.error);