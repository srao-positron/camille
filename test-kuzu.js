const { KuzuGraphDB } = require('./dist/memory/databases/kuzu-db.js');

async function testKuzu() {
  const db = new KuzuGraphDB();
  await db.connect();
  
  try {
    // Count nodes
    const nodeCount = await db.query('MATCH (n:CodeObject) RETURN count(n) as count');
    console.log('Total nodes:', nodeCount);
    
    // Sample nodes
    const sampleNodes = await db.query('MATCH (n:CodeObject) RETURN n LIMIT 5');
    console.log('Sample nodes:', JSON.stringify(sampleNodes, null, 2));
    
    // Check for classes specifically
    const classes = await db.query("MATCH (n:CodeObject) WHERE n.type = 'class' RETURN n.name, n.file LIMIT 10");
    console.log('Classes found:', JSON.stringify(classes, null, 2));
    
  } catch (error) {
    console.error('Query error:', error);
  } finally {
    await db.disconnect();
  }
}

testKuzu().catch(console.error);