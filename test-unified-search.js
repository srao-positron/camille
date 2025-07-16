const { CodeUnifiedSearch } = require('./dist/search/code-unified-search.js');

async function testUnifiedSearch() {
  console.log('Testing Unified Search with graph mode...\n');
  
  const search = new CodeUnifiedSearch();
  
  try {
    // Test graph search for TypeScript classes
    const results = await search.search('find all TypeScript classes in the codebase', {
      searchMode: 'graph',
      limit: 5,
      includeGraph: true,
      includeDependencies: true
    });
    
    console.log('Search completed!');
    console.log('Search time:', results.searchTime, 'ms');
    console.log('Graph results count:', results.graph?.length || 0);
    console.log('\n--- Graph Search Results ---\n');
    
    if (results.graph && results.graph.length > 0) {
      results.graph.forEach((result, index) => {
        console.log(`\n${index + 1}. ${result.name}`);
        console.log(`   Type: ${result.type}`);
        console.log(`   File: ${result.filePath}`);
        console.log(`   Line: ${result.lineNumber}`);
        if (result.description) {
          console.log(`   Description: ${result.description}`);
        }
        if (result.relationships && result.relationships.length > 0) {
          console.log(`   Relationships:`);
          result.relationships.forEach(rel => {
            console.log(`     - ${rel.type}: ${rel.target}`);
          });
        }
      });
    } else {
      console.log('No graph results found.');
    }
    
    // Also show if there were any vector results
    if (results.vector && results.vector.length > 0) {
      console.log(`\n\nAlso found ${results.vector.length} vector search results.`);
    }
    
  } catch (error) {
    console.error('Search error:', error);
    console.error('Stack:', error.stack);
  }
}

testUnifiedSearch().catch(console.error);