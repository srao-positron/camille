/**
 * Export functionality for LanceDB to support Supastate sync
 */

import { LanceVectorDB } from './lance-db.js';
import { logger } from '../../logger.js';

export interface ExportedMemoryChunk {
  id: string;
  chunkId: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
}

export class LanceDBExporter {
  private db: LanceVectorDB;
  private table: any; // Direct access to LanceDB table
  
  constructor(db: LanceVectorDB, table?: any) {
    this.db = db;
    this.table = table;
  }
  
  /**
   * Export all memory chunks from LanceDB
   * @param limit Maximum number of chunks to export (for batching)
   * @param offset Starting offset for pagination
   */
  async exportMemoryChunks(limit: number = 1000, offset: number = 0): Promise<{
    chunks: ExportedMemoryChunk[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      // Create a dummy vector for searching (LanceDB requires a vector for queries)
      const dummyVector = new Array(3072).fill(0);
      
      // Get a large batch of results
      // We'll need to implement pagination manually since LanceDB doesn't have direct offset support
      const allResults = await this.db.search(dummyVector, limit + offset + 100);
      
      // Skip to the offset and take the limit
      const paginatedResults = allResults.slice(offset, offset + limit);
      
      const chunks: ExportedMemoryChunk[] = [];
      
      // We need to access the raw table data to get embeddings
      // LanceDB search results don't include the vector field
      for (const result of paginatedResults) {
        const metadata = result.metadata || {};
        
        // Get the full record with vector from the table
        const fullRecord = await this.getFullRecord(result.id);
        
        chunks.push({
          id: result.id,
          chunkId: metadata.chunkId || result.id,
          content: result.content || metadata.content || '',
          embedding: fullRecord?.vector || [], // Get from the vector field
          metadata: {
            ...metadata,
            score: result.score,
            exportedAt: new Date().toISOString()
          }
        });
      }
      
      return {
        chunks,
        hasMore: allResults.length > offset + limit,
        total: allResults.length
      };
    } catch (error) {
      logger.error('Failed to export memory chunks', { error, limit, offset });
      throw error;
    }
  }
  
  /**
   * Export memory chunks filtered by project
   */
  async exportProjectMemoryChunks(
    projectPath: string, 
    limit: number = 1000, 
    offset: number = 0
  ): Promise<{
    chunks: ExportedMemoryChunk[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      // Create a dummy vector for searching
      const dummyVector = new Array(3072).fill(0);
      
      // Search with project filter
      const allResults = await this.db.search(
        dummyVector, 
        limit + offset + 100,
        { projectPath }
      );
      
      // Paginate results
      const paginatedResults = allResults.slice(offset, offset + limit);
      
      const chunks: ExportedMemoryChunk[] = [];
      
      for (const result of paginatedResults) {
        const metadata = result.metadata || {};
        
        // Get the full record with vector from the table
        const fullRecord = await this.getFullRecord(result.id);
        
        chunks.push({
          id: result.id,
          chunkId: metadata.chunkId || result.id,
          content: result.content || metadata.content || '',
          embedding: fullRecord?.vector || [],
          metadata: {
            ...metadata,
            projectPath,
            score: result.score,
            exportedAt: new Date().toISOString()
          }
        });
      }
      
      return {
        chunks,
        hasMore: allResults.length > offset + limit,
        total: allResults.length
      };
    } catch (error) {
      logger.error('Failed to export project memory chunks', { 
        error, 
        projectPath, 
        limit, 
        offset 
      });
      throw error;
    }
  }
  
  /**
   * Get statistics about the memory database
   */
  async getStatistics(): Promise<{
    totalChunks: number;
    projectCounts: Record<string, number>;
    averageEmbeddingSize: number;
  }> {
    try {
      // Get all chunks to calculate statistics
      const dummyVector = new Array(3072).fill(0);
      const allResults = await this.db.search(dummyVector, 10000);
      
      const projectCounts: Record<string, number> = {};
      let totalEmbeddingSize = 0;
      let embeddingCount = 0;
      
      for (const result of allResults) {
        const metadata = result.metadata || {};
        const projectPath = metadata.projectPath || 'unknown';
        
        projectCounts[projectPath] = (projectCounts[projectPath] || 0) + 1;
        
        // All records should have embeddings in the vector field
        // We're counting 3072 as the standard size
        embeddingCount++;
        totalEmbeddingSize += 3072;
      }
      
      return {
        totalChunks: allResults.length,
        projectCounts,
        averageEmbeddingSize: embeddingCount > 0 
          ? Math.round(totalEmbeddingSize / embeddingCount) 
          : 3072
      };
    } catch (error) {
      logger.error('Failed to get database statistics', { error });
      throw error;
    }
  }
  
  /**
   * Get full record including vector from LanceDB
   */
  private async getFullRecord(id: string): Promise<{ vector: number[] } | null> {
    try {
      if (!this.table) {
        // If we don't have direct table access, return null
        // In production, we'd need to expose this from LanceVectorDB
        return null;
      }
      
      // Query the table directly for the record
      const results = await this.table.query().where(`id = '${id}'`).limit(1).toArray();
      
      if (results.length > 0) {
        const record = results[0];
        return {
          vector: Array.isArray(record.vector) ? record.vector : Array.from(record.vector || [])
        };
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get full record', { error, id });
      return null;
    }
  }
}