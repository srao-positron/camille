/**
 * LanceDB implementation of unified embedding storage
 */

import { connect, Connection, Table } from '@lancedb/lancedb';
import * as path from 'path';
import * as os from 'os';
import { EmbeddingStore, UnifiedEmbedding } from './embedding-store.js';
import { logger } from '../logger.js';

interface LanceEmbeddingRecord {
  id: string;
  type: string;
  path: string;
  node_id?: string;
  vector: number[];
  content: string;
  content_hash: string;
  timestamp: number;
  model: string;
  dimensions: number;
  token_count?: number;
}

export class LanceEmbeddingStore implements EmbeddingStore {
  private connection?: Connection;
  private table?: Table;
  private readonly dbPath: string;
  private readonly tableName = 'unified_embeddings';
  private stats = {
    duplicatesSaved: 0
  };

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(os.homedir(), '.camille', 'memory', 'vectors', 'unified.lance');
  }

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to LanceDB embedding store', { path: this.dbPath });
      this.connection = await connect(this.dbPath);
      
      // Create or open table
      const tables = await this.connection.tableNames();
      if (tables.includes(this.tableName)) {
        this.table = await this.connection.openTable(this.tableName);
        logger.info('Opened existing embeddings table');
      } else {
        // Create new table with schema
        this.table = await this.connection.createTable({
          name: this.tableName,
          data: []
        });
        logger.info('Created new embeddings table');
      }
    } catch (error) {
      logger.error('Failed to connect to LanceDB', { error });
      throw error;
    }
  }

  async storeEmbedding(embedding: UnifiedEmbedding): Promise<void> {
    if (!this.table) {
      await this.connect();
    }

    try {
      const record: LanceEmbeddingRecord = {
        id: embedding.id,
        type: embedding.type,
        path: embedding.path,
        node_id: embedding.nodeId,
        vector: embedding.embedding,
        content: embedding.content,
        content_hash: embedding.contentHash,
        timestamp: embedding.metadata.timestamp,
        model: embedding.metadata.model,
        dimensions: embedding.metadata.dimensions,
        token_count: embedding.metadata.tokenCount
      };

      await this.table!.add([record as any]);
      logger.debug('Stored embedding', { id: embedding.id, type: embedding.type });
    } catch (error) {
      logger.error('Failed to store embedding', { error, id: embedding.id });
      throw error;
    }
  }

  async storeEmbeddings(embeddings: UnifiedEmbedding[]): Promise<void> {
    if (!this.table) {
      await this.connect();
    }

    if (embeddings.length === 0) return;

    try {
      const records: LanceEmbeddingRecord[] = embeddings.map(embedding => ({
        id: embedding.id,
        type: embedding.type,
        path: embedding.path,
        node_id: embedding.nodeId,
        vector: embedding.embedding,
        content: embedding.content,
        content_hash: embedding.contentHash,
        timestamp: embedding.metadata.timestamp,
        model: embedding.metadata.model,
        dimensions: embedding.metadata.dimensions,
        token_count: embedding.metadata.tokenCount
      }));

      await this.table!.add(records as any[]);
      logger.info('Stored embedding batch', { count: embeddings.length });
    } catch (error) {
      logger.error('Failed to store embeddings', { error, count: embeddings.length });
      throw error;
    }
  }

  async getEmbedding(id: string): Promise<UnifiedEmbedding | null> {
    if (!this.table) {
      await this.connect();
    }

    try {
      const results = await this.table!
        .vectorSearch(new Array(1536).fill(0)) // Dummy vector for filter query
        .filter(`id = '${id}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      const record = results[0] as any;
      return this.recordToEmbedding(record);
    } catch (error) {
      logger.error('Failed to get embedding', { error, id });
      return null;
    }
  }

  async getEmbeddingByHash(contentHash: string): Promise<UnifiedEmbedding | null> {
    if (!this.table) {
      await this.connect();
    }

    try {
      const results = await this.table!
        .vectorSearch(new Array(1536).fill(0)) // Dummy vector for filter query
        .filter(`content_hash = '${contentHash}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      const record = results[0] as any;
      this.stats.duplicatesSaved++;
      return this.recordToEmbedding(record);
    } catch (error) {
      logger.error('Failed to get embedding by hash', { error, contentHash });
      return null;
    }
  }

  async getFileEmbeddings(filePath: string): Promise<UnifiedEmbedding[]> {
    if (!this.table) {
      await this.connect();
    }

    try {
      const results = await this.table!
        .vectorSearch(new Array(1536).fill(0)) // Dummy vector for filter query
        .filter(`path = '${filePath}'`)
        .limit(1000)
        .toArray();

      return results.map((record: any) => this.recordToEmbedding(record as any));
    } catch (error) {
      logger.error('Failed to get file embeddings', { error, path: filePath });
      return [];
    }
  }

  async hasEmbedding(contentHash: string): Promise<boolean> {
    const embedding = await this.getEmbeddingByHash(contentHash);
    return embedding !== null;
  }

  async deleteFileEmbeddings(filePath: string): Promise<void> {
    if (!this.table) {
      await this.connect();
    }

    try {
      // LanceDB doesn't have direct delete by filter yet
      // We need to get IDs first then delete
      const embeddings = await this.getFileEmbeddings(filePath);
      if (embeddings.length === 0) return;

      // For now, log that we would delete
      logger.info('Would delete embeddings for file', { 
        path: filePath, 
        count: embeddings.length 
      });
      
      // TODO: Implement when LanceDB supports delete operations
    } catch (error) {
      logger.error('Failed to delete file embeddings', { error, path: filePath });
      throw error;
    }
  }

  async getStats(): Promise<{
    totalEmbeddings: number;
    fileEmbeddings: number;
    codeObjectEmbeddings: number;
    totalSize: number;
    duplicatesSaved: number;
  }> {
    if (!this.table) {
      await this.connect();
    }

    try {
      // Get counts by type
      const allRecords = await this.table!
        .vectorSearch(new Array(1536).fill(0))
        .limit(100000)
        .toArray();

      let fileCount = 0;
      let codeObjectCount = 0;
      let totalSize = 0;

      for (const record of allRecords) {
        const r = record as any;
        if (r.type === 'file') {
          fileCount++;
        } else if (r.type === 'code_object') {
          codeObjectCount++;
        }
        totalSize += r.content.length;
      }

      return {
        totalEmbeddings: allRecords.length,
        fileEmbeddings: fileCount,
        codeObjectEmbeddings: codeObjectCount,
        totalSize,
        duplicatesSaved: this.stats.duplicatesSaved
      };
    } catch (error) {
      logger.error('Failed to get stats', { error });
      return {
        totalEmbeddings: 0,
        fileEmbeddings: 0,
        codeObjectEmbeddings: 0,
        totalSize: 0,
        duplicatesSaved: 0
      };
    }
  }

  /**
   * Search for similar embeddings
   */
  async search(
    embedding: number[], 
    options: {
      type?: 'file' | 'code_object';
      path?: string;
      limit?: number;
    } = {}
  ): Promise<UnifiedEmbedding[]> {
    if (!this.table) {
      await this.connect();
    }

    try {
      let query = this.table!.vectorSearch(embedding);
      
      // Build filter
      const filters: string[] = [];
      if (options.type) {
        filters.push(`type = '${options.type}'`);
      }
      if (options.path) {
        filters.push(`path = '${options.path}'`);
      }
      
      if (filters.length > 0) {
        query = query.filter(filters.join(' AND '));
      }
      
      const results = await query
        .limit(options.limit || 10)
        .toArray();

      return results.map((record: any) => this.recordToEmbedding(record as any));
    } catch (error) {
      logger.error('Failed to search embeddings', { error });
      return [];
    }
  }

  private recordToEmbedding(record: LanceEmbeddingRecord): UnifiedEmbedding {
    return {
      id: record.id,
      type: record.type as 'file' | 'code_object',
      path: record.path,
      nodeId: record.node_id,
      embedding: record.vector,
      content: record.content,
      contentHash: record.content_hash,
      metadata: {
        timestamp: record.timestamp,
        model: record.model,
        dimensions: record.dimensions,
        tokenCount: record.token_count
      }
    };
  }
}