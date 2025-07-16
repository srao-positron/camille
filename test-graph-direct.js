const { KuzuGraphDB } = require('./dist/memory/databases/kuzu-db.js');
const { logger } = require('./dist/logger.js');

async function testGraphDirect() {
  console.log('Testing direct graph queries...\n');
  
  const db = new KuzuGraphDB();
  
  try {
    // Connect to the database - this will use shared connection
    await db.connect();
    console.log('Connected to Kuzu graph database\n');
    
    // Test 1: Count all TypeScript classes
    console.log('1. Counting TypeScript classes:');
    const classCountQuery = "MATCH (n:CodeObject) WHERE n.type = 'class' RETURN count(n) as count";
    const classCount = await db.query(classCountQuery);
    console.log(`   Total classes in graph: ${JSON.stringify(classCount)}\n`);
    
    // Test 2: Get sample TypeScript classes
    console.log('2. Sample TypeScript classes:');
    const classesQuery = "MATCH (n:CodeObject) WHERE n.type = 'class' RETURN n.name as name, n.file as file, n.line as line LIMIT 5";
    const classes = await db.query(classesQuery);
    console.log('   Classes found:');
    if (classes && classes.length > 0) {
      classes.forEach((cls, i) => {
        console.log(`   ${i+1}. ${cls.name} in ${cls.file} at line ${cls.line}`);
      });
    } else {
      console.log('   No classes found');
    }
    console.log();
    
    // Test 3: Find all node types
    console.log('3. All node types in graph:');
    const typesQuery = "MATCH (n:CodeObject) RETURN DISTINCT n.type as type, count(n) as count ORDER BY count DESC";
    const types = await db.query(typesQuery);
    console.log('   Node types:');
    if (types && types.length > 0) {
      types.forEach(type => {
        console.log(`   - ${type.type}: ${type.count} nodes`);
      });
    }
    console.log();
    
    // Test 4: Natural language query simulation
    console.log('4. Simulating natural language query "find all TypeScript classes":');
    // This simulates what the text2Cypher would generate
    const nlQuery = "MATCH (n:CodeObject) WHERE n.type = 'class' OR (n.type = 'interface' AND n.file =~ '.*\\\\.ts$') RETURN n.name as name, n.type as type, n.file as file, n.line as line LIMIT 10";
    const nlResults = await db.query(nlQuery);
    console.log('   Results:');
    if (nlResults && nlResults.length > 0) {
      nlResults.forEach((result, i) => {
        console.log(`   ${i+1}. ${result.type} ${result.name} in ${result.file}:${result.line}`);
      });
    } else {
      console.log('   No results found');
    }
    
  } catch (error) {
    console.error('Error during graph query:', error);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  } finally {
    // Don't disconnect - let the server maintain the connection
    console.log('\nTest completed');
  }
}

testGraphDirect().catch(console.error);