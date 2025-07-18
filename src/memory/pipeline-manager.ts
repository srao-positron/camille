/**
 * Multi-stage pipeline for efficient file processing
 * Separates CPU-bound, I/O-bound, and API-bound operations
 */

import PQueue from 'p-queue';
import * as os from 'os';
import { logger } from '../logger.js';
import { EmbeddingManager, EmbeddingRequest } from './embedding-store.js';
import { GraphDB } from './databases/graph-db.js';
import { CodeParser } from '../code-parser/parser-interface.js';
import { v4 as uuidv4 } from 'uuid';

export interface ProcessingStats {
  filesProcessed: number;
  nodesCreated: number;
  edgesCreated: number;
  embeddingsGenerated: number;
  apiCallsSaved: number;
  startTime: number;
  errors: number;
}

export interface PipelineConfig {
  parseQueueConcurrency?: number;      // CPU-bound
  embeddingQueueConcurrency?: number;  // API-bound
  graphQueueConcurrency?: number;      // I/O-bound
  batchSize?: number;                  // For batching operations
}

/**
 * Manages multi-stage processing pipeline
 */
export class PipelineManager {
  private parseQueue: PQueue;
  private embeddingQueue: PQueue;
  private graphQueue: PQueue;
  private embeddingManager: EmbeddingManager;
  private graphDB: GraphDB;
  private parser: CodeParser;
  private stats: ProcessingStats;
  
  // Batching
  private pendingNodes: any[] = [];
  private pendingEdges: any[] = [];
  private batchSize: number;
  private flushTimer?: NodeJS.Timeout;

  constructor(
    embeddingManager: EmbeddingManager,
    graphDB: GraphDB,
    parser: CodeParser,
    config: PipelineConfig = {}
  ) {
    this.embeddingManager = embeddingManager;
    this.graphDB = graphDB;
    this.parser = parser;
    
    // Calculate optimal concurrency
    const cpuCount = os.cpus().length;
    
    // Parse queue: CPU-bound, use most cores
    this.parseQueue = new PQueue({ 
      concurrency: config.parseQueueConcurrency || Math.min(Math.max(4, cpuCount - 2), 16)
    });
    
    // Embedding queue: API rate-limited
    this.embeddingQueue = new PQueue({ 
      concurrency: config.embeddingQueueConcurrency || 5
    });
    
    // Graph queue: I/O-bound, can be higher
    this.graphQueue = new PQueue({ 
      concurrency: config.graphQueueConcurrency || 20
    });
    
    this.batchSize = config.batchSize || 100;
    
    this.stats = {
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      embeddingsGenerated: 0,
      apiCallsSaved: 0,
      startTime: Date.now(),
      errors: 0
    };
    
    logger.info('Pipeline manager initialized', {
      cpuCount,
      parseQueueConcurrency: this.parseQueue.concurrency,
      embeddingQueueConcurrency: this.embeddingQueue.concurrency,
      graphQueueConcurrency: this.graphQueue.concurrency,
      batchSize: this.batchSize
    });
  }

  /**
   * Process multiple files through the pipeline
   */
  async processFiles(files: Array<{ path: string; content: string }>): Promise<ProcessingStats> {
    logger.info('Starting pipeline processing', { fileCount: files.length });
    this.stats.startTime = Date.now();
    
    try {
      // Stage 1: Parse all files in parallel
      const parsedFiles = await this.parseStage(files);
      
      // Stage 2: Generate embeddings in batches
      await this.embeddingStage(parsedFiles);
      
      // Stage 3: Write to graph database
      await this.graphStage(parsedFiles);
      
      // Stage 4: Edge resolution (will be implemented later)
      // await this.edgeResolutionStage();
      
      // Flush any remaining batches
      await this.flush();
      
      const duration = Date.now() - this.stats.startTime;
      logger.info('Pipeline processing completed', {
        ...this.stats,
        duration,
        filesPerSecond: (this.stats.filesProcessed / duration) * 1000
      });
      
      return this.stats;
      
    } catch (error) {
      logger.error('Pipeline processing failed', { error });
      throw error;
    }
  }

  /**
   * Stage 1: Parse files to extract code structure
   */
  private async parseStage(files: Array<{ path: string; content: string }>): Promise<any[]> {
    logger.info('Stage 1: Parsing files', { count: files.length });
    
    const parsePromises = files.map(file => 
      this.parseQueue.add(async () => {
        try {
          const parsed = await this.parser.parse(file.path, file.content);
          this.stats.filesProcessed++;
          
          logger.debug('File parsed', {
            path: file.path,
            nodes: parsed.nodes.length,
            edges: parsed.edges.length
          });
          
          return { ...parsed, content: file.content };
        } catch (error) {
          logger.error('Failed to parse file', { path: file.path, error });
          this.stats.errors++;
          return null;
        }
      })
    );
    
    const results = await Promise.all(parsePromises);
    return results.filter(r => r !== null);
  }

  /**
   * Stage 2: Generate embeddings for all code objects
   */
  private async embeddingStage(parsedFiles: any[]): Promise<void> {
    logger.info('Stage 2: Generating embeddings');
    
    // Collect all embedding requests
    const embeddingRequests: EmbeddingRequest[] = [];
    
    for (const parsed of parsedFiles) {
      // File-level embedding
      embeddingRequests.push({
        id: uuidv4(),
        type: 'file',
        path: parsed.file,
        content: this.generateFileContent(parsed)
      });
      
      // Code object embeddings
      for (const node of parsed.nodes) {
        embeddingRequests.push({
          id: uuidv4(),
          type: 'code_object',
          path: parsed.file,
          nodeId: node.id,
          content: this.generateNodeContent(node)
        });
      }
    }
    
    logger.info('Queueing embeddings', { count: embeddingRequests.length });
    
    // Queue all embeddings (will be batched automatically)
    await this.embeddingManager.queueEmbeddings(embeddingRequests);
    
    // Flush to ensure all embeddings are generated
    await this.embeddingManager.flush();
    
    this.stats.embeddingsGenerated = embeddingRequests.length;
    const efficiency = this.embeddingManager.getStats().efficiency;
    this.stats.apiCallsSaved = Math.floor(embeddingRequests.length * (1 - 1/efficiency));
  }

  /**
   * Stage 3: Write nodes and edges to graph database
   */
  private async graphStage(parsedFiles: any[]): Promise<void> {
    logger.info('Stage 3: Writing to graph database');
    
    // Collect all nodes and edges
    for (const parsed of parsedFiles) {
      // Add nodes to batch
      this.pendingNodes.push(...parsed.nodes);
      
      // Add edges to batch
      this.pendingEdges.push(...parsed.edges);
      
      // Check if we should flush
      if (this.pendingNodes.length >= this.batchSize) {
        await this.flushNodes();
      }
      
      if (this.pendingEdges.length >= this.batchSize) {
        await this.flushEdges();
      }
    }
    
    // Final flush
    await this.flush();
  }

  /**
   * Flush pending batches
   */
  private async flush(): Promise<void> {
    await Promise.all([
      this.flushNodes(),
      this.flushEdges()
    ]);
  }

  /**
   * Flush pending nodes to graph
   */
  private async flushNodes(): Promise<void> {
    if (this.pendingNodes.length === 0) return;
    
    const nodes = this.pendingNodes.splice(0, this.batchSize);
    
    await this.graphQueue.add(async () => {
      try {
        await this.graphDB.addNodes(nodes);
        this.stats.nodesCreated += nodes.length;
        logger.debug('Flushed nodes to graph', { count: nodes.length });
      } catch (error) {
        logger.error('Failed to flush nodes', { error, count: nodes.length });
        this.stats.errors++;
      }
    });
  }

  /**
   * Flush pending edges to graph
   */
  private async flushEdges(): Promise<void> {
    if (this.pendingEdges.length === 0) return;
    
    const edges = this.pendingEdges.splice(0, this.batchSize);
    
    await this.graphQueue.add(async () => {
      try {
        await this.graphDB.addEdges(edges);
        this.stats.edgesCreated += edges.length;
        logger.debug('Flushed edges to graph', { count: edges.length });
      } catch (error) {
        logger.error('Failed to flush edges', { error, count: edges.length });
        this.stats.errors++;
      }
    });
  }

  /**
   * Generate content for file embedding
   */
  private generateFileContent(parsed: any): string {
    const fileName = parsed.file.split('/').pop() || '';
    const summary = `File ${fileName} contains ${parsed.nodes.length} code objects`;
    const preview = parsed.content.substring(0, 8000);
    
    return `${fileName}\n${summary}\n\n${preview}`;
  }

  /**
   * Generate content for node embedding
   */
  private generateNodeContent(node: any): string {
    const parts = [
      `${node.type} ${node.name}`,
      node.metadata?.description || '',
      node.metadata?.signature || '',
      JSON.stringify(node.metadata?.parameters || [])
    ].filter(Boolean);
    
    return parts.join(' ');
  }

  /**
   * Get processing statistics
   */
  getStats(): ProcessingStats {
    return { ...this.stats };
  }

  /**
   * Wait for all queues to complete
   */
  async waitForCompletion(): Promise<void> {
    await Promise.all([
      this.parseQueue.onIdle(),
      this.embeddingQueue.onIdle(),
      this.graphQueue.onIdle()
    ]);
  }
}