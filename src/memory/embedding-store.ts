/**
 * Unified embedding storage system
 * Manages embeddings for both vector search and graph nodes
 */

import { logger } from '../logger.js';
import * as crypto from 'crypto';

export interface UnifiedEmbedding {
  id: string;                    // Unique identifier
  type: 'file' | 'code_object';  // Type of embedding
  path: string;                  // File path
  nodeId?: string;              // For code objects
  embedding: number[];          // The actual embedding vector
  content: string;              // What was embedded
  contentHash: string;          // SHA256 of content for deduplication
  metadata: {
    timestamp: number;
    model: string;
    dimensions: number;
    tokenCount?: number;
  };
}

export interface EmbeddingRequest {
  id: string;
  type: 'file' | 'code_object';
  path: string;
  nodeId?: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface EmbeddingBatch {
  requests: EmbeddingRequest[];
  timestamp: number;
}

/**
 * Storage interface for embeddings
 */
export interface EmbeddingStore {
  /**
   * Store a single embedding
   */
  storeEmbedding(embedding: UnifiedEmbedding): Promise<void>;

  /**
   * Store multiple embeddings in batch
   */
  storeEmbeddings(embeddings: UnifiedEmbedding[]): Promise<void>;

  /**
   * Get embedding by ID
   */
  getEmbedding(id: string): Promise<UnifiedEmbedding | null>;

  /**
   * Get embeddings by content hash (for deduplication)
   */
  getEmbeddingByHash(contentHash: string): Promise<UnifiedEmbedding | null>;

  /**
   * Get all embeddings for a file
   */
  getFileEmbeddings(path: string): Promise<UnifiedEmbedding[]>;

  /**
   * Check if content already has embedding
   */
  hasEmbedding(contentHash: string): Promise<boolean>;

  /**
   * Delete embeddings for a file
   */
  deleteFileEmbeddings(path: string): Promise<void>;

  /**
   * Get statistics
   */
  getStats(): Promise<{
    totalEmbeddings: number;
    fileEmbeddings: number;
    codeObjectEmbeddings: number;
    totalSize: number;
    duplicatesSaved: number;
  }>;
}

/**
 * Manages embedding generation and storage
 */
export class EmbeddingManager {
  private store: EmbeddingStore;
  private openaiClient: any; // Will be injected
  private pendingBatch: EmbeddingRequest[] = [];
  private batchSize = 100; // OpenAI max batch size
  private flushInterval = 100; // ms
  private flushTimer?: NodeJS.Timeout;
  private stats = {
    apiCalls: 0,
    embeddingsGenerated: 0,
    duplicatesAvoided: 0,
    batchesProcessed: 0
  };

  constructor(store: EmbeddingStore, openaiClient: any) {
    this.store = store;
    this.openaiClient = openaiClient;
  }

  /**
   * Queue embedding generation request
   */
  async queueEmbedding(request: EmbeddingRequest): Promise<string> {
    // Check if we already have this embedding
    const contentHash = this.hashContent(request.content);
    const existing = await this.store.getEmbeddingByHash(contentHash);
    
    if (existing) {
      logger.debug('Using cached embedding', { 
        type: request.type, 
        path: request.path,
        nodeId: request.nodeId 
      });
      this.stats.duplicatesAvoided++;
      return existing.id;
    }

    // Add to batch
    this.pendingBatch.push(request);
    
    // Check if we should flush
    if (this.pendingBatch.length >= this.batchSize) {
      await this.flushBatch();
    } else {
      // Schedule flush
      this.scheduleFlush();
    }

    return request.id;
  }

  /**
   * Queue multiple embeddings
   */
  async queueEmbeddings(requests: EmbeddingRequest[]): Promise<string[]> {
    const ids: string[] = [];
    
    for (const request of requests) {
      const id = await this.queueEmbedding(request);
      ids.push(id);
    }
    
    return ids;
  }

  /**
   * Force flush any pending embeddings
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    
    if (this.pendingBatch.length > 0) {
      await this.flushBatch();
    }
  }

  /**
   * Get embedding generation statistics
   */
  getStats() {
    return {
      ...this.stats,
      efficiency: this.stats.embeddingsGenerated / Math.max(1, this.stats.apiCalls)
    };
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushBatch().catch(error => {
          logger.error('Failed to flush embedding batch', { error });
        });
      }, this.flushInterval);
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.pendingBatch.length === 0) return;

    const batch = this.pendingBatch.splice(0, this.batchSize);
    this.stats.batchesProcessed++;

    try {
      logger.info('Processing embedding batch', { 
        size: batch.length,
        types: batch.reduce((acc, r) => {
          acc[r.type] = (acc[r.type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      });

      // Generate embeddings (will be implemented with OpenAI client)
      const embeddings = await this.generateBatchEmbeddings(batch);
      
      // Store all embeddings
      await this.store.storeEmbeddings(embeddings);
      
      this.stats.apiCalls++;
      this.stats.embeddingsGenerated += embeddings.length;
      
      logger.info('Embedding batch processed', {
        processed: embeddings.length,
        totalGenerated: this.stats.embeddingsGenerated,
        efficiency: this.stats.embeddingsGenerated / this.stats.apiCalls
      });
      
    } catch (error) {
      logger.error('Failed to process embedding batch', { error });
      // Re-queue failed items
      this.pendingBatch.unshift(...batch);
      throw error;
    }
  }

  private async generateBatchEmbeddings(requests: EmbeddingRequest[]): Promise<UnifiedEmbedding[]> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    // Extract content from requests
    const contents = requests.map(req => req.content);
    
    // Generate embeddings using batch API
    const embeddings = await this.openaiClient.generateBatchEmbeddings(contents);
    
    // Map embeddings back to unified format
    return requests.map((req, idx) => ({
      id: req.id,
      type: req.type,
      path: req.path,
      nodeId: req.nodeId,
      embedding: embeddings[idx],
      content: req.content,
      contentHash: this.hashContent(req.content),
      metadata: {
        timestamp: Date.now(),
        model: this.openaiClient.config?.models?.embedding || 'text-embedding-3-small',
        dimensions: embeddings[idx].length,
        tokenCount: Math.ceil(req.content.length / 4) // Approximate
      }
    }));
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

/**
 * Generate content for file embedding
 */
export function generateFileEmbeddingText(file: {
  path: string;
  content: string;
  summary?: string;
}): string {
  const fileName = file.path.split('/').pop() || '';
  const parts = [
    `File: ${fileName}`,
    file.summary || '',
    file.content.substring(0, 8000) // Limit content size
  ].filter(Boolean);
  
  return parts.join('\n\n');
}

/**
 * Generate content for code object embedding
 */
export function generateCodeObjectEmbeddingText(node: {
  type: string;
  name: string;
  file: string;
  metadata?: any;
}): string {
  const fileName = node.file.split('/').pop() || '';
  const parts = [
    `${node.type} ${node.name}`,
    `in ${fileName}`,
    node.metadata?.description || '',
    node.metadata?.signature || ''
  ].filter(Boolean);
  
  return parts.join(' ');
}