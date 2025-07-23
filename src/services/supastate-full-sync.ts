/**
 * Full sync implementation for Supastate that properly exports LanceDB data
 */

import { ConfigManager } from '../config.js';
import { SupastateClient, MemoryChunk } from './supastate-client.js';
import { LanceDBDirectAccess } from '../memory/databases/lance-direct-access.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';
import { logger } from '../logger.js';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

export interface SyncProgress {
  totalChunks: number;
  syncedChunks: number;
  failedChunks: number;
  currentBatch: number;
  totalBatches: number;
}

export class SupastateFullSync {
  private config: ConfigManager;
  private client: SupastateClient | null = null;
  private lanceDB: LanceDBDirectAccess;
  private graphDB: KuzuGraphDB | null = null;
  private isEnabled: boolean = false;
  
  constructor() {
    this.config = new ConfigManager();
    const supastate = this.config.getConfig().supastate;
    
    if (supastate?.enabled && supastate.url && supastate.apiKey) {
      try {
        this.client = new SupastateClient();
        this.isEnabled = true;
      } catch (error) {
        logger.error('Failed to initialize Supastate client:', error);
      }
    }
    
    this.lanceDB = new LanceDBDirectAccess('transcripts');
  }
  
  /**
   * Perform a full sync of all local data to Supastate
   */
  async fullSync(progressCallback?: (progress: SyncProgress) => void): Promise<{
    success: boolean;
    memoriesSynced: number;
    graphsSynced: number;
    errors: string[];
  }> {
    if (!this.client || !this.isEnabled) {
      throw new Error('Supastate not enabled or configured');
    }
    
    const errors: string[] = [];
    let memoriesSynced = 0;
    let graphsSynced = 0;
    
    console.log(chalk.blue('🔄 Starting full Supastate sync...'));
    
    try {
      // Sync memories
      const memoryResult = await this.syncAllMemories(progressCallback);
      memoriesSynced = memoryResult.synced;
      errors.push(...memoryResult.errors);
      
      // Sync graphs
      const graphResult = await this.syncAllGraphs();
      graphsSynced = graphResult.synced;
      errors.push(...graphResult.errors);
      
      console.log(chalk.green('✅ Full sync completed'));
      console.log(chalk.gray(`  Memories synced: ${memoriesSynced}`));
      console.log(chalk.gray(`  Graphs synced: ${graphsSynced}`));
      
      if (errors.length > 0) {
        console.log(chalk.yellow(`  Errors: ${errors.length}`));
      }
      
      return {
        success: errors.length === 0,
        memoriesSynced,
        graphsSynced,
        errors
      };
    } catch (error) {
      console.error(chalk.red('❌ Full sync failed:'), error);
      throw error;
    }
  }
  
  /**
   * Sync all memories from LanceDB to Supastate
   */
  private async syncAllMemories(progressCallback?: (progress: SyncProgress) => void): Promise<{
    synced: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let totalSynced = 0;
    
    try {
      console.log(chalk.gray('📊 Analyzing local memory database...'));
      
      // Connect to LanceDB
      await this.lanceDB.connect();
      
      // Get statistics
      const stats = await this.lanceDB.getExportStats();
      console.log(chalk.gray(`  Total chunks: ${stats.totalRecords}`));
      console.log(chalk.gray(`  Projects: ${Object.keys(stats.projectCounts).length}`));
      console.log(chalk.gray(`  Size: ${(stats.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`));
      
      // Export all chunks
      console.log(chalk.gray('📤 Exporting memory chunks...'));
      const allChunks = await this.lanceDB.exportAllChunks();
      
      if (allChunks.length === 0) {
        console.log(chalk.gray('No memory chunks to sync'));
        return { synced: 0, errors: [] };
      }
      
      // Group by project for better organization
      const chunksByProject = new Map<string, typeof allChunks>();
      for (const chunk of allChunks) {
        const projectPath = chunk.projectPath || 'default';
        if (!chunksByProject.has(projectPath)) {
          chunksByProject.set(projectPath, []);
        }
        chunksByProject.get(projectPath)!.push(chunk);
      }
      
      // Sync each project
      for (const [projectPath, projectChunks] of chunksByProject) {
        console.log(chalk.gray(`\n  Syncing project: ${projectPath} (${projectChunks.length} chunks)`));
        
        // Get project name from path
        const projectName = path.basename(projectPath) || 'default';
        
        // Batch sync for better performance
        const batchSize = 50; // Smaller batches for large embeddings
        const totalBatches = Math.ceil(projectChunks.length / batchSize);
        
        for (let i = 0; i < projectChunks.length; i += batchSize) {
          const batch = projectChunks.slice(i, i + batchSize);
          const currentBatch = Math.floor(i / batchSize) + 1;
          
          if (progressCallback) {
            progressCallback({
              totalChunks: allChunks.length,
              syncedChunks: totalSynced,
              failedChunks: errors.length,
              currentBatch,
              totalBatches
            });
          }
          
          try {
            console.log(chalk.gray(`    Batch ${currentBatch}/${totalBatches}...`));
            
            // Convert to Supastate format
            const memoryChunks: MemoryChunk[] = batch.map(chunk => ({
              chunkId: chunk.chunkId,
              content: chunk.content,
              embedding: chunk.embedding,
              metadata: {
                sessionId: chunk.sessionId,
                startTime: chunk.startTime,
                endTime: chunk.endTime,
                messageCount: chunk.messageCount,
                topics: chunk.topics,
                chunkIndex: chunk.chunkIndex,
                ...chunk.metadata
              }
            }));
            
            // Sync to Supastate
            const result = await this.client!.syncMemories(projectName, memoryChunks);
            
            if (result.success) {
              totalSynced += batch.length;
            } else {
              errors.push(`Failed to sync batch ${currentBatch} for ${projectName}: ${result.error}`);
              console.error(chalk.red(`    ❌ Batch ${currentBatch} failed: ${result.error}`));
            }
          } catch (error) {
            const errorMsg = `Error syncing batch ${currentBatch} for ${projectName}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
            console.error(chalk.red(`    ❌ ${errorMsg}`));
          }
        }
      }
      
      await this.lanceDB.close();
      
      console.log(chalk.green(`✅ Memory sync completed: ${totalSynced}/${allChunks.length} chunks`));
      
      return {
        synced: totalSynced,
        errors
      };
    } catch (error) {
      logger.error('Memory sync failed:', error);
      errors.push(`Memory sync error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        synced: totalSynced,
        errors
      };
    }
  }
  
  /**
   * Sync all graphs from Kuzu to Supastate
   */
  private async syncAllGraphs(): Promise<{
    synced: number;
    errors: string[];
  }> {
    // TODO: Implement graph sync when Kuzu export is ready
    console.log(chalk.gray('📊 Graph sync not yet implemented'));
    
    return {
      synced: 0,
      errors: []
    };
  }
  
  /**
   * Get sync checkpoint to resume from
   */
  private async getSyncCheckpoint(): Promise<{
    lastSyncedChunkId?: string;
    lastSyncTime?: string;
  }> {
    try {
      const checkpointPath = path.join(os.homedir(), '.camille', 'sync-checkpoint.json');
      const data = await fs.readFile(checkpointPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return {};
    }
  }
  
  /**
   * Save sync checkpoint
   */
  private async saveSyncCheckpoint(checkpoint: {
    lastSyncedChunkId: string;
    lastSyncTime: string;
  }): Promise<void> {
    try {
      const checkpointPath = path.join(os.homedir(), '.camille', 'sync-checkpoint.json');
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
    } catch (error) {
      logger.error('Failed to save sync checkpoint:', error);
    }
  }
}