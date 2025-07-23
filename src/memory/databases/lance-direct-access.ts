/**
 * Direct access to LanceDB for exporting data with embeddings
 */

import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../logger.js';

export interface LanceDBRecord {
  id: string;
  vector: number[];
  data: string;
}

export interface ExportedChunk {
  id: string;
  chunkId: string;
  content: string;
  embedding: number[];
  sessionId?: string;
  projectPath?: string;
  startTime?: string;
  endTime?: string;
  messageCount?: number;
  topics?: string[];
  chunkIndex?: number;
  metadata: Record<string, any>;
}

export class LanceDBDirectAccess {
  private db?: any;
  private table?: any;
  private readonly dbPath: string;
  private readonly tableName: string;
  
  constructor(tableName: string = 'transcripts') {
    this.tableName = tableName;
    this.dbPath = path.join(os.homedir(), '.camille', 'memory', 'vectors');
  }
  
  async connect(): Promise<void> {
    try {
      this.db = await lancedb.connect(this.dbPath);
      const tables = await this.db.tableNames();
      
      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
        logger.info(`Connected to LanceDB table: ${this.tableName}`);
      } else {
        throw new Error(`Table ${this.tableName} not found`);
      }
    } catch (error) {
      logger.error('Failed to connect to LanceDB', { error });
      throw error;
    }
  }
  
  /**
   * Export all chunks with full data including embeddings
   */
  async exportAllChunks(limit: number = 10000): Promise<ExportedChunk[]> {
    if (!this.table) {
      throw new Error('Not connected to database');
    }
    
    try {
      logger.info('Starting full export from LanceDB', { limit });
      
      // Query all records
      const records = await this.table
        .query()
        .limit(limit)
        .toArray();
      
      logger.info(`Retrieved ${records.length} records from LanceDB`);
      
      const chunks: ExportedChunk[] = [];
      
      for (const record of records) {
        try {
          // Parse the data JSON
          const data = JSON.parse(record.data || '{}');
          
          // Ensure vector is a proper array
          const vector = Array.isArray(record.vector) 
            ? record.vector 
            : Array.from(record.vector || []);
          
          chunks.push({
            id: record.id,
            chunkId: data.chunkId || record.id,
            content: data.content || '',
            embedding: vector,
            sessionId: data.sessionId,
            projectPath: data.projectPath,
            startTime: data.startTime,
            endTime: data.endTime,
            messageCount: data.messageCount,
            topics: data.topics,
            chunkIndex: data.chunkIndex,
            metadata: {
              ...data,
              vectorDimensions: vector.length,
              exportedAt: new Date().toISOString()
            }
          });
        } catch (error) {
          logger.error('Failed to process record', { 
            error, 
            recordId: record.id,
            dataLength: record.data?.length 
          });
        }
      }
      
      logger.info(`Successfully exported ${chunks.length} chunks with embeddings`);
      
      return chunks;
    } catch (error) {
      logger.error('Failed to export chunks', { error });
      throw error;
    }
  }
  
  /**
   * Export chunks for a specific project
   */
  async exportProjectChunks(projectPath: string, limit: number = 10000): Promise<ExportedChunk[]> {
    const allChunks = await this.exportAllChunks(limit);
    
    // Filter by project
    return allChunks.filter(chunk => chunk.projectPath === projectPath);
  }
  
  /**
   * Get export statistics
   */
  async getExportStats(): Promise<{
    totalRecords: number;
    projectCounts: Record<string, number>;
    sessionCounts: Record<string, number>;
    averageEmbeddingSize: number;
    totalSizeBytes: number;
  }> {
    if (!this.table) {
      throw new Error('Not connected to database');
    }
    
    try {
      const records = await this.table.query().limit(10000).toArray();
      
      const projectCounts: Record<string, number> = {};
      const sessionCounts: Record<string, number> = {};
      let totalEmbeddingSize = 0;
      let totalSizeBytes = 0;
      
      for (const record of records) {
        try {
          const data = JSON.parse(record.data || '{}');
          const projectPath = data.projectPath || 'unknown';
          const sessionId = data.sessionId || 'unknown';
          
          projectCounts[projectPath] = (projectCounts[projectPath] || 0) + 1;
          sessionCounts[sessionId] = (sessionCounts[sessionId] || 0) + 1;
          
          const vector = Array.isArray(record.vector) ? record.vector : Array.from(record.vector || []);
          totalEmbeddingSize += vector.length;
          
          // Estimate size: vector (4 bytes per float) + data string
          totalSizeBytes += (vector.length * 4) + (record.data?.length || 0);
        } catch (error) {
          logger.debug('Failed to process record for stats', { error });
        }
      }
      
      return {
        totalRecords: records.length,
        projectCounts,
        sessionCounts,
        averageEmbeddingSize: records.length > 0 
          ? Math.round(totalEmbeddingSize / records.length) 
          : 3072,
        totalSizeBytes
      };
    } catch (error) {
      logger.error('Failed to get export stats', { error });
      throw error;
    }
  }
  
  async close(): Promise<void> {
    this.db = undefined;
    this.table = undefined;
  }
}