const fetch = require('node-fetch');

async function testGraphSearchAPI() {
  console.log('Testing Graph Search via Server API...\n');
  
  const searchQuery = {
    query: 'find all TypeScript classes in the codebase',
    searchMode: 'graph',
    limit: 5,
    includeGraph: true,
    includeDependencies: true
  };
  
  try {
    // Make a request to the server's search endpoint
    const response = await fetch('http://localhost:3001/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchQuery)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    
    console.log('Search completed successfully!');
    console.log('Total results:', result.results?.length || 0);
    console.log('\n--- Graph Search Results ---\n');
    
    if (result.results && result.results.length > 0) {
      result.results.forEach((item, index) => {
        console.log(`\n${index + 1}. ${item.path}`);
        console.log(`   Similarity: ${item.similarity}`);
        console.log(`   Summary: ${item.summary}`);
        
        if (item.graphMatches && item.graphMatches.length > 0) {
          console.log(`   Graph Matches:`);
          item.graphMatches.forEach(match => {
            console.log(`     - ${match.node.name} (${match.node.type}) at line ${match.node.lineNumber}`);
          });
        }
      });
    } else {
      console.log('No results found.');
    }
    
    // Show status
    if (result.indexStatus) {
      console.log('\n--- Index Status ---');
      console.log(`Ready: ${result.indexStatus.ready}`);
      console.log(`Files indexed: ${result.indexStatus.filesIndexed}`);
      console.log(`Currently indexing: ${result.indexStatus.isIndexing}`);
    }
    
  } catch (error) {
    console.error('API call failed:', error.message);
    console.log('\nMake sure the Camille server is running on port 3001');
  }
}

testGraphSearchAPI().catch(console.error);