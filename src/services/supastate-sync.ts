/**
 * Supastate sync service for automatic synchronization of memories and graphs
 */

import { ConfigManager } from '../config.js';
import { SupastateClient, MemoryChunk, GraphData, GraphNode, GraphEdge } from './supastate-client.js';
import { EmbeddingsIndex, SearchResult } from '../embeddings.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';
import { LanceDBDirectAccess } from '../memory/databases/lance-direct-access.js';
import { logger } from '../logger.js';
import chalk from 'chalk';
import * as path from 'path';
import * as os from 'os';

export class SupastateSyncService {
  private config: ConfigManager;
  private client: SupastateClient | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private isEnabled: boolean = false;
  private embeddingsIndex: EmbeddingsIndex | null = null;
  private graphDb: KuzuGraphDB | null = null;

  constructor() {
    this.config = new ConfigManager();
    const supastate = this.config.getConfig().supastate;
    
    logger.info('SupastateSyncService constructor', {
      enabled: supastate?.enabled,
      hasUrl: !!supastate?.url,
      hasApiKey: !!supastate?.apiKey,
      teamId: supastate?.teamId
    });
    
    if (supastate?.enabled && supastate.url && supastate.apiKey) {
      try {
        this.client = new SupastateClient();
        this.isEnabled = true;
        logger.info('SupastateSyncService enabled successfully');
      } catch (error) {
        logger.error('Failed to initialize Supastate client:', error);
      }
    } else {
      logger.info('SupastateSyncService not enabled - missing configuration');
    }
  }

  /**
   * Check if Supastate sync is enabled
   */
  isSupastateEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Initialize the sync service with database instances
   */
  async initialize(embeddingsIndex: EmbeddingsIndex, graphDb: KuzuGraphDB): Promise<void> {
    this.embeddingsIndex = embeddingsIndex;
    this.graphDb = graphDb;
    
    if (this.isEnabled && this.config.getConfig().supastate?.autoSync) {
      await this.startAutoSync();
    }
  }

  /**
   * Start automatic synchronization
   */
  async startAutoSync(): Promise<void> {
    if (!this.client || !this.isEnabled) {
      throw new Error('Supastate not enabled or configured');
    }

    const syncInterval = this.config.getConfig().supastate?.syncInterval || 30; // Default 30 minutes
    
    // Do initial sync
    await this.syncAll();
    
    // Set up interval
    this.syncInterval = setInterval(async () => {
      try {
        await this.syncAll();
      } catch (error) {
        logger.error('Auto sync failed:', error);
      }
    }, syncInterval * 60 * 1000);
    
    console.log(chalk.green(`✅ Supastate auto-sync started (every ${syncInterval} minutes)`));
  }

  /**
   * Stop automatic synchronization
   */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log(chalk.yellow('⏹ Supastate auto-sync stopped'));
    }
  }

  /**
   * Sync all data (memories and graphs)
   */
  async syncAll(): Promise<void> {
    if (!this.client) {
      throw new Error('Supastate client not initialized');
    }

    console.log(chalk.blue('🔄 Starting Supastate sync...'));
    
    try {
      // Sync memories
      await this.syncMemories();
      
      // Sync code graphs
      await this.syncGraphs();
      
      console.log(chalk.green('✅ Supastate sync completed'));
    } catch (error) {
      console.error(chalk.red('❌ Supastate sync failed:'), error);
      throw error;
    }
  }

  /**
   * Sync memories to Supastate
   */
  async syncMemories(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    try {
      console.log(chalk.blue('🔄 Starting memory sync to Supastate...'));
      
      // Use LanceDB direct access to get real embeddings
      const lanceDir = path.join(os.homedir(), '.camille', 'embeddings');
      const lanceAccess = new LanceDBDirectAccess(lanceDir);
      
      try {
        await lanceAccess.connect();
        
        // Export all chunks with real embeddings
        const exportedChunks = await lanceAccess.exportAllChunks(10000); // Limit for initial sync
        
        if (exportedChunks.length === 0) {
          console.log(chalk.gray('No memories to sync'));
          return;
        }
        
        console.log(chalk.gray(`Found ${exportedChunks.length} memory chunks to sync`));
        
        // Group chunks by project
        const chunksByProject = new Map<string, MemoryChunk[]>();
        
        for (const chunk of exportedChunks) {
          const projectPath = chunk.projectPath || 'unknown';
          const projectName = path.basename(projectPath);
          
          if (!chunksByProject.has(projectName)) {
            chunksByProject.set(projectName, []);
          }
          
          // Convert exported chunk to MemoryChunk format
          const memoryChunk: MemoryChunk = {
            chunkId: chunk.chunkId,
            content: chunk.content,
            embedding: chunk.embedding, // Real embedding from LanceDB
            metadata: {
              sessionId: chunk.sessionId,
              conversationId: chunk.metadata?.conversationId,
              messageType: chunk.metadata?.messageType,
              filePaths: chunk.metadata?.filePath ? [chunk.metadata.filePath] : [],
              timestamp: chunk.metadata?.timestamp,
              hasCode: chunk.metadata?.hasCode,
              codeLanguage: chunk.metadata?.codeLanguage,
              summary: chunk.metadata?.summary,
              projectPath: chunk.projectPath,
              syncedAt: new Date().toISOString(),
            },
          };
          
          chunksByProject.get(projectName)!.push(memoryChunk);
        }
        
        // Sync each project's chunks using batch sync
        let totalSynced = 0;
        let totalFailed = 0;
        
        for (const [projectName, chunks] of chunksByProject) {
          console.log(chalk.gray(`Syncing ${chunks.length} chunks for project: ${projectName}`));
          
          // Use batch sync for better performance
          const batchSize = 50;
          const totalBatches = Math.ceil(chunks.length / batchSize);
          
          for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const currentBatch = Math.floor(i / batchSize) + 1;
            
            console.log(chalk.gray(`  Batch ${currentBatch}/${totalBatches} (${batch.length} chunks)`));
            
            const result = await this.client.batchSyncMemories(
              projectName, 
              batch,
              {
                totalBatches,
                currentBatch,
                syncSessionId: `sync-${Date.now()}`,
              }
            );
            
            if (result.success) {
              totalSynced += result.processed || 0;
              totalFailed += result.failed || 0;
            } else {
              logger.error(`Batch sync failed for ${projectName}:`, result.error);
              totalFailed += batch.length;
            }
          }
        }
        
        console.log(chalk.green(`✅ Memory sync completed`));
        console.log(chalk.gray(`   Synced: ${totalSynced} chunks`));
        if (totalFailed > 0) {
          console.log(chalk.yellow(`   Failed: ${totalFailed} chunks`));
        }
        
      } finally {
        await lanceAccess.close();
      }
    } catch (error) {
      logger.error('Memory sync error:', error);
      console.error(chalk.red('❌ Memory sync failed:'), error);
      throw error;
    }
  }

  /**
   * Sync code graphs to Supastate
   */
  async syncGraphs(): Promise<void> {
    // Code graph sync not implemented yet
    console.log(chalk.gray('Code graph sync not implemented yet'));
    return;
  }

  /**
   * Get sync status
   */
  async getStatus(): Promise<any> {
    if (!this.client) {
      return {
        enabled: false,
        message: 'Supastate not configured',
      };
    }

    try {
      const projectName = path.basename(process.cwd());
      const status = await this.client.getSyncStatus(projectName);
      const connected = await this.client.testConnection();
      
      return {
        enabled: true,
        connected,
        autoSync: !!this.syncInterval,
        projectName,
        ...status,
      };
    } catch (error) {
      return {
        enabled: true,
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Search memories including team memories from Supastate
   * Note: This is a placeholder for future integration with unified search
   */
  async searchWithTeam(query: string, embedding: number[], limit: number = 10): Promise<SearchResult[]> {
    if (!this.client || !this.isEnabled) {
      return [];
    }

    try {
      // Search team memories
      const teamResults = await this.client.searchMemories(query, embedding, undefined, limit);
      
      // Convert to SearchResult format
      return teamResults.map((result: any) => ({
        path: result.metadata?.filePath || 'team-memory',
        content: result.content,
        embedding: result.embedding,
        similarity: result.similarity || 0.5,
        metadata: {
          ...result.metadata,
          source: 'team',
        },
      }));
    } catch (error) {
      logger.error('Team search failed:', error);
      return [];
    }
  }
}