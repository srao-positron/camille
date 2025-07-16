const { KuzuGraphDB } = require('./dist/memory/databases/kuzu-db.js');

async function testGraph() {
  const db = new KuzuGraphDB();
  
  try {
    await db.connect();
    console.log('Connected to Kuzu');
    
    // Count all nodes
    const result = await db.query('MATCH (n:CodeObject) RETURN count(n) as count');
    console.log('Total nodes in graph:', result);
    
    // Count by type
    const typeCount = await db.query("MATCH (n:CodeObject) RETURN n.type as type, count(n) as count ORDER BY count DESC LIMIT 10");
    console.log('Nodes by type:', typeCount);
    
    // Sample class nodes
    const classes = await db.query("MATCH (n:CodeObject) WHERE n.type = 'class' RETURN n.name, n.file LIMIT 5");
    console.log('Sample classes:', classes);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await db.disconnect();
  }
}

testGraph().catch(console.error);