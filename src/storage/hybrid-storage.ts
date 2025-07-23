/**
 * Hybrid storage that can use either local or Supastate storage
 */

import { logger } from '../logger.js';
import { ConfigManager } from '../config.js';
import { SupastateStorageProvider } from './supastate-provider.js';
import { StorageProvider, MemoryChunk, CodeFile, SearchResult, GraphResult } from './types.js';
import { EmbeddingsIndex } from '../embeddings.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';

export class HybridStorage implements StorageProvider {
  private config: ConfigManager;
  private provider: StorageProvider | null = null;
  private localEmbeddings?: EmbeddingsIndex;
  private localGraph?: KuzuGraphDB;
  private useSupastate: boolean = false;

  constructor(embeddingsIndex?: EmbeddingsIndex, graphDb?: KuzuGraphDB) {
    this.config = new ConfigManager();
    this.localEmbeddings = embeddingsIndex;
    this.localGraph = graphDb;
    
    // Check if Supastate is enabled with server-side processing
    const supastate = this.config.getConfig().supastate;
    if (supastate?.enabled && supastate?.serverSideProcessing) {
      try {
        this.provider = new SupastateStorageProvider();
        this.useSupastate = true;
        logger.info('Using Supastate for storage (server-side processing)');
      } catch (error) {
        logger.error('Failed to initialize Supastate provider:', error);
        logger.info('Falling back to local storage');
      }
    }
  }

  async addMemory(sessionId: string, chunk: MemoryChunk): Promise<void> {
    if (this.useSupastate && this.provider) {
      // Send to Supastate for processing
      await this.provider.addMemory(sessionId, chunk);
    } else if (this.localEmbeddings) {
      // Use local embeddings
      // Note: This would need to be adapted to work with the new chunk format
      logger.warn('Local embedding storage not fully implemented for new format');
    }
  }

  async searchMemories(query: string, limit?: number): Promise<SearchResult[]> {
    if (this.useSupastate && this.provider) {
      return await this.provider.searchMemories(query, limit);
    } else if (this.localEmbeddings) {
      // Use local search
      const results = await this.localEmbeddings.search(query, limit || 20);
      return results.map(r => ({
        content: r.content,
        score: r.score,
        metadata: r.metadata || {},
        chunkId: r.metadata?.chunkId || '',
      }));
    }
    return [];
  }

  async addCodeFile(projectPath: string, file: CodeFile): Promise<void> {
    if (this.useSupastate && this.provider) {
      await this.provider.addCodeFile(projectPath, file);
    } else if (this.localGraph) {
      // Use local graph storage
      logger.warn('Local graph storage not adapted for new format yet');
    }
  }

  async queryGraph(query: string): Promise<GraphResult> {
    if (this.useSupastate && this.provider) {
      return await this.provider.queryGraph(query);
    } else if (this.localGraph) {
      // Use local graph
      logger.warn('Local graph query not adapted for new format yet');
      return { nodes: [], edges: [] };
    }
    return { nodes: [], edges: [] };
  }

  async close(): Promise<void> {
    if (this.provider) {
      await this.provider.close();
    }
  }

  isUsingSupastate(): boolean {
    return this.useSupastate;
  }
}