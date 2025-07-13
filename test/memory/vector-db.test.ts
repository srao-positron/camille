/**
 * Tests for vector database abstractions
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LanceVectorDB } from '../../src/memory/databases/lance-db';
import { VectorDB, SearchResult } from '../../src/memory/databases/vector-db';

describe('VectorDB Abstraction', () => {
  let vectorDB: VectorDB;
  let testDbPath: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDbPath = path.join(os.tmpdir(), 'camille-test-vectors-' + Date.now());
    process.env.CAMILLE_CONFIG_DIR = testDbPath;
    
    // Create a new instance with the test path
    const TestLanceVectorDB = class extends LanceVectorDB {
      constructor(tableName: string) {
        super(tableName);
        // Override the dbPath to use test directory
        (this as any).dbPath = path.join(testDbPath, '.camille', 'memory', 'vectors');
      }
    };
    
    vectorDB = new TestLanceVectorDB('test-table');
  });

  afterEach(async () => {
    // Clean up
    if (vectorDB) {
      await vectorDB.close();
    }
    
    // Remove test directory
    try {
      await fs.rm(testDbPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('LanceVectorDB', () => {
    it('should create database directory automatically on connect', async () => {
      // Directory should not exist before connect
      const dbPath = path.join(testDbPath, '.camille', 'memory', 'vectors');
      await expect(fs.access(dbPath)).rejects.toThrow();

      // Connect should create the directory
      await vectorDB.connect();

      // Directory should now exist
      await expect(fs.access(dbPath)).resolves.toBeUndefined();
    });

    it('should connect successfully', async () => {
      await expect(vectorDB.connect()).resolves.toBeUndefined();
    });

    it('should index a vector with metadata', async () => {
      await vectorDB.connect();

      const embedding = Array(1536).fill(0.1);
      const metadata = {
        content: 'Test content',
        timestamp: new Date().toISOString(),
        source: 'test'
      };

      const id = await vectorDB.index(embedding, metadata);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should search for similar vectors', async () => {
      await vectorDB.connect();

      // Index some test vectors
      const embedding1 = Array(1536).fill(0).map((_, i) => i % 2 ? 0.1 : -0.1);
      const embedding2 = Array(1536).fill(0).map((_, i) => i % 2 ? 0.2 : -0.2);
      const embedding3 = Array(1536).fill(0).map((_, i) => i % 2 ? -0.1 : 0.1);

      const id1 = await vectorDB.index(embedding1, { content: 'Document 1', type: 'test' });
      const id2 = await vectorDB.index(embedding2, { content: 'Document 2', type: 'test' });
      const id3 = await vectorDB.index(embedding3, { content: 'Document 3', type: 'other' });

      // Search with a query similar to embedding1
      const queryEmbedding = Array(1536).fill(0).map((_, i) => i % 2 ? 0.15 : -0.15);
      const results = await vectorDB.search(queryEmbedding, 2);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBeDefined();
      expect(results[0].score).toBeDefined();
      expect(results[0].metadata).toBeDefined();
    });

    it('should filter search results by metadata', async () => {
      await vectorDB.connect();

      // Index vectors with different metadata
      const embedding = Array(1536).fill(0.1);
      
      await vectorDB.index(embedding, { content: 'Doc 1', type: 'test' });
      await vectorDB.index(embedding, { content: 'Doc 2', type: 'test' });
      await vectorDB.index(embedding, { content: 'Doc 3', type: 'other' });

      // Search with filter
      const results = await vectorDB.search(embedding, 10, { type: 'test' });

      // Should only return documents with type='test'
      expect(results.length).toBeGreaterThanOrEqual(2);
      results.forEach(result => {
        expect(result.metadata.type).toBe('test');
      });
    });

    it('should update metadata for a document', async () => {
      await vectorDB.connect();

      const embedding = Array(1536).fill(0.1);
      const originalMetadata = { content: 'Original', version: 1 };

      const id = await vectorDB.index(embedding, originalMetadata);

      // Update metadata
      await vectorDB.updateMetadata(id, { version: 2, updated: true });

      // Search to verify update
      const results = await vectorDB.search(embedding, 1);
      expect(results[0].metadata.version).toBe(2);
      expect(results[0].metadata.updated).toBe(true);
      expect(results[0].metadata.content).toBe('Original'); // Should preserve existing fields
    });

    it('should delete a document', async () => {
      await vectorDB.connect();

      const embedding = Array(1536).fill(0.1);
      const id = await vectorDB.index(embedding, { content: 'To be deleted' });

      // Delete the document
      await vectorDB.delete(id);

      // Search should not find it
      const results = await vectorDB.search(embedding, 10);
      const deletedDoc = results.find(r => r.id === id);
      expect(deletedDoc).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      // Should throw error when not connected
      const embedding = Array(1536).fill(0.1);
      await expect(vectorDB.index(embedding, {})).rejects.toThrow('Database not connected');
      await expect(vectorDB.search(embedding, 10)).rejects.toThrow('Database not connected');
      await expect(vectorDB.updateMetadata('test-id', {})).rejects.toThrow('Database not connected');
      await expect(vectorDB.delete('test-id')).rejects.toThrow('Database not connected');
    });

    it('should handle concurrent operations', async () => {
      await vectorDB.connect();

      const promises: Promise<string>[] = [];
      
      // Index 10 vectors concurrently
      for (let i = 0; i < 10; i++) {
        const embedding = Array(1536).fill(i / 10);
        promises.push(vectorDB.index(embedding, { index: i }));
      }

      const ids = await Promise.all(promises);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10); // All IDs should be unique
    });
  });
});