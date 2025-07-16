/**
 * LanceDB implementation of the VectorDB interface
 */

import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { VectorDB, SearchResult } from './vector-db.js';
import { logger } from '../../logger.js';
import * as crypto from 'crypto';

export class LanceVectorDB implements VectorDB {
  private db?: any; // LanceDB types are complex, using any for now
  private table?: any;
  private readonly dbPath: string;
  private readonly tableName: string;

  constructor(tableName: string = 'transcripts') {
    this.tableName = tableName;
    // Use the home directory path that will be created automatically
    this.dbPath = path.join(os.homedir(), '.camille', 'memory', 'vectors');
  }

  async connect(): Promise<void> {
    try {
      // Ensure directory exists
      await this.ensureDirectoryExists();
      
      // Connect to LanceDB
      this.db = await lancedb.connect(this.dbPath);
      
      // Check if table exists
      const tables = await this.db.tableNames();
      
      if (tables.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
      } else {
        // Create table with minimal schema - just store everything as JSON
        this.table = await this.db.createTable(this.tableName, [
          {
            id: 'init',
            vector: Array(3072).fill(0), // text-embedding-3-large dimension
            data: '{}' // Store all data as JSON string
          }
        ]);
        
        // Delete the initial record
        await this.delete('init');
      }
      
      logger.info(`Connected to LanceDB table: ${this.tableName}`);
    } catch (error) {
      logger.error('Failed to connect to LanceDB', { error });
      throw error;
    }
  }

  async index(embedding: number[], metadata: any): Promise<string> {
    if (!this.table) {
      throw new Error('Database not connected. Call connect() first.');
    }

    const id = crypto.randomUUID();
    
    try {
      // Store all data as JSON for flexibility
      const record = {
        id,
        vector: embedding,
        data: JSON.stringify({
          content: metadata.content || '',
          ...metadata
        })
      };
      
      await this.table.add([record]);
      
      return id;
    } catch (error) {
      logger.error('Failed to index vector', { error, id });
      throw error;
    }
  }

  async search(
    embedding: number[], 
    limit: number = 10,
    filter?: Record<string, any>
  ): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      logger.info('Starting vector search', { 
        embeddingLength: embedding.length,
        limit,
        hasFilter: !!filter,
        filter,
        tableName: this.tableName
      });
      
      // Search for similar vectors
      const results = await this.table
        .vectorSearch(embedding)
        .limit(limit * 2) // Get extra results for filtering
        .toArray();
      
      logger.info('Vector search completed', { resultsCount: results.length });
      
      // Parse data and apply filters manually
      let filteredResults = results;
      
      if (filter) {
        filteredResults = results.filter((result: any) => {
          try {
            const data = JSON.parse(result.data || '{}');
            return Object.entries(filter).every(([key, value]) => data[key] === value);
          } catch (e) {
            return false;
          }
        });
      }
      
      // Limit after filtering
      filteredResults = filteredResults.slice(0, limit);
      
      return filteredResults.map((result: any) => {
        const data = JSON.parse(result.data || '{}');
        return {
          id: result.id,
          score: result._distance || 0,
          metadata: data,
          content: data.content || ''
        };
      });
    } catch (error) {
      logger.error('Search failed', { 
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        type: error?.constructor?.name
      });
      throw error;
    }
  }

  async updateMetadata(id: string, metadata: any): Promise<void> {
    if (!this.table) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Search for the record by id
      const results = await this.table.query().where(`id = '${id}'`).limit(1).toArray();
      
      if (results.length === 0) {
        throw new Error(`Record with id ${id} not found`);
      }
      
      const record = results[0];
      
      if (!record) {
        throw new Error(`Record with id ${id} not found`);
      }
      
      // Parse existing data
      const existingData = JSON.parse(record.data || '{}');
      const updatedData = { ...existingData, ...metadata };
      
      // Ensure vector is a proper array
      const vectorArray = Array.isArray(record.vector) ? record.vector : Array.from(record.vector);
      
      const updated = {
        id: record.id,
        vector: vectorArray,
        data: JSON.stringify(updatedData)
      };
      
      // Delete old and insert new
      await this.delete(id);
      await this.table.add([updated]);
    } catch (error) {
      logger.error('Failed to update metadata', { error, id });
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.table) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      await this.table.delete(`id = '${id}'`);
    } catch (error) {
      logger.error('Failed to delete record', { error, id });
      throw error;
    }
  }

  async close(): Promise<void> {
    // LanceDB doesn't require explicit closing
    this.db = undefined;
    this.table = undefined;
  }

  /**
   * Retrieve a specific chunk by its ID
   */
  async retrieveByChunkId(chunkId: string): Promise<SearchResult | null> {
    if (!this.table) {
      throw new Error('Not connected to database');
    }

    try {
      logger.debug('Retrieving chunk by ID', { chunkId });
      
      // Get all records and filter by chunk ID
      // LanceDB doesn't support direct metadata queries, so we need to scan all records
      // First, create a dummy vector to satisfy the search requirement
      // Using 3072 dimensions for text-embedding-3-large
      const dummyVector = new Array(3072).fill(0);
      
      const results = await this.table
        .search(dummyVector)
        .limit(10000) // Get a large batch to search through
        .toArray();
      
      // Find the specific chunk
      const chunk = results.find((result: any) => {
        try {
          const data = JSON.parse(result.data || '{}');
          return data.chunkId === chunkId;
        } catch (e) {
          return false;
        }
      });
      
      if (!chunk) {
        return null;
      }
      
      const data = JSON.parse(chunk.data || '{}');
      return {
        id: chunk.id,
        score: 1.0, // Perfect match for direct retrieval
        metadata: data,
        content: data.content || ''
      };
    } catch (error) {
      logger.error('Failed to retrieve chunk by ID', { 
        error: error instanceof Error ? error.message : error,
        chunkId 
      });
      throw error;
    }
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.mkdir(this.dbPath, { recursive: true });
    } catch (error) {
      logger.error('Failed to create database directory', { error, path: this.dbPath });
      throw error;
    }
  }
}