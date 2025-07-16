#!/usr/bin/env node

/**
 * Script to re-index edges in the graph database
 * Run this after updating the parser to fix edge detection
 */

const { KuzuGraphDB } = require('./dist/memory/databases/kuzu-db.js');
const { codeParser } = require('./dist/code-parser/code-parser.js');
const fs = require('fs');
const path = require('path');
const { logger } = require('./dist/logger.js');

async function reindexEdges() {
  console.log('🔄 Starting edge re-indexing...');
  
  try {
    // Connect to the graph database
    const graphDB = new KuzuGraphDB();
    await graphDB.connect();
    console.log('✅ Connected to graph database');
    
    // Get current stats
    const nodeCount = await graphDB.getNodeCount();
    const edgeCountBefore = await graphDB.getEdgeCount();
    console.log(`📊 Current state: ${nodeCount} nodes, ${edgeCountBefore} edges`);
    
    // Get all code files from the database
    const filesQuery = "MATCH (n:CodeObject) RETURN DISTINCT n.file as file";
    const filesResult = await graphDB.query(filesQuery);
    const files = filesResult.map(r => r.file).filter(f => f && f.startsWith('/'));
    console.log(`📁 Found ${files.length} unique files in database`);
    
    // Process each file to extract edges
    let totalEdges = 0;
    let processedFiles = 0;
    const pendingEdges = [];
    
    for (const filePath of files) {
      try {
        // Skip if parser can't handle this file
        if (!codeParser.canParse(filePath)) {
          continue;
        }
        
        // Skip if file doesn't exist
        if (!fs.existsSync(filePath)) {
          console.log(`⚠️  File not found: ${filePath}`);
          continue;
        }
        
        // Read and parse the file
        const content = fs.readFileSync(filePath, 'utf8');
        const parsedFile = await codeParser.parseFile(filePath, content);
        
        if (parsedFile && parsedFile.edges.length > 0) {
          console.log(`📝 Found ${parsedFile.edges.length} edges in ${path.basename(filePath)}`);
          pendingEdges.push(...parsedFile.edges);
          totalEdges += parsedFile.edges.length;
        }
        
        processedFiles++;
        if (processedFiles % 100 === 0) {
          console.log(`Progress: ${processedFiles}/${files.length} files processed`);
        }
      } catch (error) {
        console.error(`❌ Error parsing ${filePath}:`, error.message);
      }
    }
    
    console.log(`\n📊 Parsed ${processedFiles} files, found ${totalEdges} edges`);
    
    // Now create the edges, auto-creating missing nodes
    console.log('\n🔗 Creating edges in graph database...');
    let successCount = 0;
    let failureCount = 0;
    const builtIns = new Set([
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'fetch', 'console', 'require', 'parseInt', 'parseFloat',
      'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
      'encodeURIComponent', 'decodeURIComponent', 'eval',
      'JSON', 'Math', 'Date', 'Array', 'Object', 'String',
      'Number', 'Boolean', 'RegExp', 'Error', 'Promise'
    ]);
    
    for (const edge of pendingEdges) {
      try {
        // Check if target node exists
        const targetParts = edge.target.split(':');
        if (targetParts.length >= 4) {
          const targetFile = targetParts[0];
          const targetType = targetParts[1];
          const targetName = targetParts[2];
          
          // Check if node exists
          const checkQuery = `MATCH (n:CodeObject {id: '${edge.target}'}) RETURN n`;
          const result = await graphDB.query(checkQuery);
          
          if (result.length === 0) {
            // Node doesn't exist - create it as external/built-in
            const isBuiltIn = builtIns.has(targetName);
            const createNodeQuery = `
              CREATE (n:CodeObject {
                id: '${edge.target}',
                type: '${targetType}',
                name: '${targetName}',
                file: '${targetFile}',
                line: 0,
                metadata: '{"external": true, "builtIn": ${isBuiltIn}}'
              })
            `;
            await graphDB.query(createNodeQuery);
            console.log(`✨ Created ${isBuiltIn ? 'built-in' : 'external'} node: ${targetName}`);
          }
          
          // Now create the edge
          const createEdgeQuery = `
            MATCH (source:CodeObject {id: '${edge.source}'}), 
                  (target:CodeObject {id: '${edge.target}'})
            CREATE (source)-[:${edge.relationship}]->(target)
          `;
          await graphDB.query(createEdgeQuery);
          successCount++;
        }
      } catch (error) {
        failureCount++;
        console.error(`Failed to create edge: ${error.message}`);
      }
    }
    
    // Get final edge count
    const edgeCountAfter = await graphDB.getEdgeCount();
    
    console.log('\n✅ Edge re-indexing complete!');
    console.log(`📊 Results:`);
    console.log(`   - Edges before: ${edgeCountBefore}`);
    console.log(`   - Edges after: ${edgeCountAfter}`);
    console.log(`   - New edges created: ${edgeCountAfter - edgeCountBefore}`);
    console.log(`   - Success: ${successCount}`);
    console.log(`   - Failed: ${failureCount}`);
    
    await graphDB.close();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the script
reindexEdges().catch(console.error);