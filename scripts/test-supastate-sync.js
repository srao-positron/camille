#!/usr/bin/env node

/**
 * Test script for syncing Camille data to local Supastate
 */

import { LanceDBDirectAccess } from './src/memory/databases/lance-direct-access.js';
import chalk from 'chalk';

async function testSync() {
  console.log(chalk.blue('🔄 Testing Camille -> Supastate sync...'));
  
  try {
    // Connect to LanceDB
    const lanceDB = new LanceDBDirectAccess('transcripts');
    await lanceDB.connect();
    
    // Get statistics
    const stats = await lanceDB.getExportStats();
    console.log(chalk.gray('\n📊 Local database statistics:'));
    console.log(chalk.gray(`  Total records: ${stats.totalRecords}`));
    console.log(chalk.gray(`  Projects: ${Object.keys(stats.projectCounts).length}`));
    console.log(chalk.gray(`  Sessions: ${Object.keys(stats.sessionCounts).length}`));
    console.log(chalk.gray(`  Average embedding size: ${stats.averageEmbeddingSize}`));
    console.log(chalk.gray(`  Total size: ${(stats.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`));
    
    // Export a small sample
    console.log(chalk.blue('\n📤 Exporting sample data...'));
    const chunks = await lanceDB.exportAllChunks(5); // Just 5 for testing
    
    console.log(chalk.gray(`\n✅ Exported ${chunks.length} chunks`));
    
    // Display sample chunk
    if (chunks.length > 0) {
      const sample = chunks[0];
      console.log(chalk.gray('\n📝 Sample chunk:'));
      console.log(chalk.gray(`  ID: ${sample.id}`));
      console.log(chalk.gray(`  Chunk ID: ${sample.chunkId}`));
      console.log(chalk.gray(`  Project: ${sample.projectPath || 'N/A'}`));
      console.log(chalk.gray(`  Session: ${sample.sessionId || 'N/A'}`));
      console.log(chalk.gray(`  Content length: ${sample.content.length} chars`));
      console.log(chalk.gray(`  Embedding dimensions: ${sample.embedding.length}`));
      console.log(chalk.gray(`  Content preview: ${sample.content.substring(0, 100)}...`));
    }
    
    // Test sync to Supastate
    console.log(chalk.blue('\n🔄 Syncing to local Supastate...'));
    
    // Prepare data for Supastate API
    const memoryChunks = chunks.map(chunk => ({
      chunkId: chunk.chunkId,
      content: chunk.content,
      embedding: chunk.embedding,
      messageType: chunk.metadata?.messageType,
      metadata: {
        sessionId: chunk.sessionId,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        messageCount: chunk.messageCount,
        topics: chunk.topics,
        chunkIndex: chunk.chunkIndex,
        filePaths: chunk.metadata?.filePaths || [],
        entitiesMentioned: chunk.metadata?.entitiesMentioned || [],
        toolsUsed: chunk.metadata?.toolsUsed || [],
        hasCode: chunk.metadata?.hasCode || false,
        summary: chunk.metadata?.summary || ''
      }
    }));
    
    // Call Supastate API
    const response = await fetch('http://localhost:3001/api/memories/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token' // Will need real auth
      },
      body: JSON.stringify({
        projectName: 'camille-test',
        sessionId: chunks[0]?.sessionId || 'test-session',
        chunks: memoryChunks
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(chalk.green(`✅ Sync successful: ${result.synced} chunks synced`));
      if (result.failed > 0) {
        console.log(chalk.yellow(`⚠️  ${result.failed} chunks failed`));
      }
    } else {
      const error = await response.text();
      console.error(chalk.red(`❌ Sync failed: ${response.status} ${response.statusText}`));
      console.error(chalk.red(error));
    }
    
    await lanceDB.close();
  } catch (error) {
    console.error(chalk.red('❌ Test failed:'), error);
    process.exit(1);
  }
}

// Run the test
testSync().catch(console.error);