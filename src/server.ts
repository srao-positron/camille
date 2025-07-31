/**
 * Server mode implementation for Camille
 * Runs as a background service with file watching and embedding indexing
 */

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import { glob } from 'glob';
import PQueue from 'p-queue';
import ora from 'ora';
import chalk from 'chalk';
import { ConfigManager } from './config';
import { LLMClient } from './llm-client';
import { OpenAIClient } from './openai-client';
import { EmbeddingsIndex, FileFilter, SearchResult } from './embeddings';
import { EMBEDDING_PROMPT } from './prompts';
import { consoleOutput, isQuietMode } from './utils/console';
import { KuzuGraphDB } from './memory/databases/kuzu-db.js';
import { codeParser } from './code-parser/code-parser.js';
import { CodeUnifiedSearch, EnhancedSearchResult, CodeSearchOptions } from './search/code-unified-search.js';
import { logger } from './logger';
import { TOOLS } from './mcp-server';
import { CodeNode, CodeEdge } from './memory/databases/graph-db.js';
import { CamilleAPIServer } from './api-server.js';
import { EdgeResolver, PendingEdge } from './memory/edge-resolver.js';
import { EmbeddingManager, EmbeddingRequest } from './memory/embedding-store.js';
import { LanceEmbeddingStore } from './memory/lance-embedding-store.js';
import { PipelineManager } from './memory/pipeline-manager.js';
import { SupastateSyncService } from './services/supastate-sync.js';
import { SupastateStorageProvider } from './storage/supastate-provider.js';

/**
 * Server status
 */
export interface ServerStatus {
  isRunning: boolean;
  isIndexing: boolean;
  indexSize: number;
  queueSize: number;
  watchedDirectories: string[];
  graphIndexing: {
    isReady: boolean;
    isIndexing: boolean;
    nodeCount: number;
    edgeCount: number;
  };
}

/**
 * Camille server class
 */
export class CamilleServer {
  private configManager: ConfigManager;
  private llmClient: LLMClient;
  private openaiClient!: OpenAIClient;
  private embeddingsIndex: EmbeddingsIndex;
  private graphDB: KuzuGraphDB;
  private fileFilter: FileFilter;
  private watchers: Map<string, chokidar.FSWatcher>;
  private watchedDirectories: Set<string>;
  private indexQueue: PQueue;
  private status: ServerStatus;
  private spinner?: any;
  private configWatcher?: chokidar.FSWatcher;
  private lastConfigContent?: string;
  private pipeServer?: any;
  private pipePath: string;
  private activeJobs: Set<string> = new Set();
  private pendingEdges: Map<string, CodeEdge[]> = new Map();
  private isProcessingEdges: boolean = false;
  private apiServer?: CamilleAPIServer;
  private unifiedSearch?: CodeUnifiedSearch;
  private edgeResolver?: EdgeResolver;
  private embeddingManager?: EmbeddingManager;
  private pipelineManager?: PipelineManager;
  private parsedFiles: any[] = [];
  private supastateSyncService?: SupastateSyncService;
  private supastateProvider?: SupastateStorageProvider;

  constructor() {
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    
    // Initialize LLM client (always needed for code reviews)
    this.llmClient = new LLMClient(config, process.cwd());
    
    // Only initialize OpenAI client and embeddings if Supastate is not enabled
    if (!config.supastate?.enabled) {
      const openaiApiKey = this.configManager.getOpenAIApiKey();
      this.openaiClient = new OpenAIClient(openaiApiKey, config, process.cwd());
      this.embeddingsIndex = new EmbeddingsIndex(this.configManager);
    } else {
      logger.info('Supastate enabled - skipping OpenAI client and local embeddings initialization');
      // Create minimal embeddings index for compatibility
      this.embeddingsIndex = new EmbeddingsIndex(this.configManager);
    }
    
    this.graphDB = new KuzuGraphDB();
    this.fileFilter = new FileFilter(config.ignorePatterns);
    
    // Initialize collections
    this.watchers = new Map();
    this.watchedDirectories = new Set();
    
    // Queue for processing files with optimal concurrency
    // Use CPU count minus 2 for file parsing (CPU-bound)
    // But limit to reasonable max to avoid overwhelming the system
    const cpuCount = os.cpus().length;
    const optimalConcurrency = Math.min(Math.max(4, cpuCount - 2), 16);
    this.indexQueue = new PQueue({ concurrency: optimalConcurrency });
    
    logger.info('File processing queue initialized', { 
      cpuCount, 
      concurrency: optimalConcurrency 
    });
    
    this.status = {
      isRunning: false,
      isIndexing: false,
      indexSize: 0,
      queueSize: 0,
      watchedDirectories: [],
      graphIndexing: {
        isReady: false,
        isIndexing: false,
        nodeCount: 0,
        edgeCount: 0
      }
    };
    
    // Set up named pipe path in ~/.camille directory for consistency
    const pipeDir = process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille');
    this.pipePath = process.platform === 'win32' 
      ? '\\\\.\\pipe\\camille-mcp'
      : path.join(pipeDir, 'camille-mcp.sock');
  }

  /**
   * Starts the server with one or more directories
   */
  public async start(directories: string | string[] = process.cwd()): Promise<void> {
    consoleOutput.info(chalk.blue('🚀 Starting Camille server...'));
    logger.logServerEvent('server_starting', { directories });
    
    this.status.isRunning = true;
    
    // Register this instance with ServerManager
    ServerManager.setInstance(this);
    
    // Initialize graph database only if Supastate is not enabled
    const config = this.configManager.getConfig();
    if (!config.supastate?.enabled) {
      try {
        await this.graphDB.connect();
        consoleOutput.info(chalk.green('✅ Graph database connected'));
        
        // Create vector indices for semantic search in graph
        await this.graphDB.createVectorIndices();
        
        // Update initial graph statistics
        this.status.graphIndexing.isReady = true;
        this.status.graphIndexing.nodeCount = await this.graphDB.getNodeCount();
        this.status.graphIndexing.edgeCount = await this.graphDB.getEdgeCount();
        
        logger.info('📊 Initial graph statistics', {
          nodeCount: this.status.graphIndexing.nodeCount,
          edgeCount: this.status.graphIndexing.edgeCount
        });
        consoleOutput.info(chalk.green('✅ Graph vector indices created'));
      } catch (error) {
        logger.error('Failed to connect to graph database', { error });
        consoleOutput.warning(chalk.yellow('⚠️  Graph database unavailable - search will use vector only'));
      }
    } else {
      logger.info('Graph database disabled when Supastate is enabled');
      consoleOutput.info(chalk.yellow('ℹ️  Graph database disabled - using Supastate for all operations'));
    }
    
    // Initialize new components only if not using Supastate
      if (!config.supastate?.enabled) {
        const embeddingStore = new LanceEmbeddingStore();
        await embeddingStore.connect();
        this.embeddingManager = new EmbeddingManager(embeddingStore, this.openaiClient!);
        this.pipelineManager = new PipelineManager(
          this.embeddingManager,
          this.graphDB,
          codeParser
        );
      }
      
      // Initialize edge resolver only if graph database is enabled
      if (!config.supastate?.enabled) {
        this.edgeResolver = new EdgeResolver(this.graphDB);
      }
      
      // Initialize unified search only if not using Supastate
      if (!config.supastate?.enabled) {
        this.unifiedSearch = new CodeUnifiedSearch(
          this.embeddingsIndex,
          this.graphDB,
          this.openaiClient
        );
      }
      
      // Initialize Supastate sync service if enabled
      logger.info('Checking Supastate configuration', { 
        enabled: config.supastate?.enabled,
        hasUrl: !!config.supastate?.url,
        hasApiKey: !!config.supastate?.apiKey,
        teamId: config.supastate?.teamId
      });
      
      if (config.supastate?.enabled) {
        try {
          this.supastateSyncService = new SupastateSyncService();
          const isEnabled = this.supastateSyncService.isSupastateEnabled();
          logger.info('SupastateSyncService created', { isEnabled });
          
          if (!isEnabled) {
            throw new Error('SupastateSyncService failed to enable');
          }
          
          await this.supastateSyncService.initialize(this.embeddingsIndex, this.graphDB);
          consoleOutput.info(chalk.green('✅ Supastate sync service initialized'));
        } catch (error) {
          logger.error('Failed to initialize Supastate sync', { error });
          consoleOutput.warning(chalk.yellow('⚠️  Supastate sync unavailable'));
          this.supastateSyncService = undefined;
        }
      } else {
        logger.info('Supastate sync not enabled in config');
      }
      
      // Initialize SupastateStorageProvider for server-side processing
      if (config.supastate?.enabled) {
        try {
          this.supastateProvider = new SupastateStorageProvider();
          logger.info('SupastateStorageProvider initialized for server-side processing');
          consoleOutput.info(chalk.green('✅ Using Supastate for server-side embedding generation'));
        } catch (error) {
          logger.error('Failed to initialize SupastateStorageProvider:', error);
          consoleOutput.warning(chalk.yellow('⚠️  Falling back to local embedding generation'));
        }
      }
    
    // Start the named pipe server IMMEDIATELY for MCP communication
    await this.startPipeServer();
    consoleOutput.info(chalk.green('✅ MCP server ready - accepting connections'));
    
    // Start the REST API server
    try {
      this.apiServer = new CamilleAPIServer();
      await this.apiServer.start();
      consoleOutput.info(chalk.green('✅ REST API server started on http://localhost:3456'));
    } catch (error) {
      logger.error('Failed to start API server', { error });
      consoleOutput.warning(chalk.yellow('⚠️  REST API server unavailable'));
    }
    
    // Normalize to array
    const dirsToWatch = Array.isArray(directories) ? directories : [directories];
    
    // If no directories to watch, mark index as ready
    if (dirsToWatch.length === 0) {
      this.embeddingsIndex.setReady(true);
      consoleOutput.info(chalk.gray('No directories to index'));
    } else {
      // Start indexing directories in the background (sequentially to avoid locking issues)
      consoleOutput.info(chalk.gray('Starting background indexing...'));
      this.startBackgroundIndexing(dirsToWatch);
    }
    
    logger.logServerEvent('server_started', { 
      directories: this.getWatchedDirectories(),
      pipeReady: true,
      indexing: dirsToWatch.length > 0
    });
    
    // Set up config file watching
    this.setupConfigWatcher();
    
    // Start transcript indexing as a separate background job
    this.startTranscriptIndexingJob();
  }

  /**
   * Starts indexing directories in the background
   */
  private async startBackgroundIndexing(directories: string[]): Promise<void> {
    // Don't await - let it run in background
    (async () => {
      try {
        // Process directories sequentially to avoid graph database locking issues
        for (const dir of directories) {
          logger.info(`Starting indexing for directory: ${dir}`);
          await this.addDirectory(dir);
          logger.info(`Completed indexing for directory: ${dir}`);
        }
        
        // Wait for index to be ready
        while (!this.embeddingsIndex.isIndexReady()) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        consoleOutput.success('✅ Indexing complete');
        consoleOutput.info(chalk.gray(`Indexed files: ${this.embeddingsIndex.getIndexSize()}`));
        
        logger.logServerEvent('indexing_completed', { 
          directories: this.getWatchedDirectories(),
          indexSize: this.embeddingsIndex.getIndexSize() 
        });
      } catch (error) {
        logger.error('Background indexing failed', error as Error);
        consoleOutput.error(`Background indexing failed: ${error}`);
      }
    })();
  }

  /**
   * Starts the transcript indexing job in the background
   */
  private startTranscriptIndexingJob(): void {
    const jobId = 'transcripts';
    this.activeJobs.add(jobId);
    
    // Don't await - let it run independently
    (async () => {
      try {
        logger.info('Starting transcript indexing job');
        await this.indexExistingTranscripts();
        logger.info('Completed transcript indexing job');
      } catch (error) {
        logger.error('Transcript indexing job failed', error as Error);
      } finally {
        this.activeJobs.delete(jobId);
        await this.checkAllJobsComplete();
      }
    })();
  }

  /**
   * Check if all indexing jobs are complete
   */
  private async checkAllJobsComplete(): Promise<void> {
    if (this.activeJobs.size === 0) {
      consoleOutput.success('✅ All indexing jobs complete');
      consoleOutput.info(chalk.gray(`Total indexed files: ${this.embeddingsIndex.getIndexSize()}`));
      
      logger.logServerEvent('all_indexing_completed', { 
        directories: this.getWatchedDirectories(),
        indexSize: this.embeddingsIndex.getIndexSize() 
      });
      
      // Process pending edges in second pass
      if (this.pendingEdges.size > 0) {
        logger.info('Starting second pass for edge processing', {
          pendingFiles: this.pendingEdges.size
        });
        await this.processPendingEdges();
      }
    } else {
      logger.info(`Active indexing jobs remaining: ${this.activeJobs.size}`, { 
        jobs: Array.from(this.activeJobs) 
      });
    }
  }

  /**
   * Adds a directory to watch
   */
  public async addDirectory(directory: string): Promise<void> {
    const absPath = path.resolve(directory);
    
    // Check if already watching
    if (this.watchedDirectories.has(absPath)) {
      consoleOutput.warning(`Already watching: ${absPath}`);
      return;
    }
    
    // Verify directory exists
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      throw new Error(`Not a valid directory: ${absPath}`);
    }
    
    consoleOutput.info(chalk.blue(`Adding directory: ${absPath}`));
    
    // Add to watched set
    this.watchedDirectories.add(absPath);
    this.status.watchedDirectories = Array.from(this.watchedDirectories);
    
    // Index the directory
    await this.performInitialIndexing(absPath);
    
    // Set up file watcher
    this.setupFileWatcher(absPath);
    
    consoleOutput.success(`✅ Now watching: ${absPath}`);
    logger.logServerEvent('directory_added', { directory: absPath });
  }
  
  /**
   * Removes a directory from watching
   */
  public async removeDirectory(directory: string): Promise<void> {
    const absPath = path.resolve(directory);
    
    if (!this.watchedDirectories.has(absPath)) {
      consoleOutput.warning(`Not watching: ${absPath}`);
      return;
    }
    
    consoleOutput.info(chalk.blue(`Removing directory: ${absPath}`));
    
    // Close the watcher
    const watcher = this.watchers.get(absPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(absPath);
    }
    
    // Remove from watched set
    this.watchedDirectories.delete(absPath);
    this.status.watchedDirectories = Array.from(this.watchedDirectories);
    
    // Remove files from index
    const indexedFiles = this.embeddingsIndex.getIndexedFiles();
    for (const file of indexedFiles) {
      if (file.startsWith(absPath)) {
        this.embeddingsIndex.removeFile(file);
      }
    }
    
    consoleOutput.success(`✅ Stopped watching: ${absPath}`);
    logger.logServerEvent('directory_removed', { directory: absPath });
  }
  
  /**
   * Gets list of watched directories
   */
  public getWatchedDirectories(): string[] {
    return Array.from(this.watchedDirectories);
  }
  
  /**
   * Stops the server
   */
  public async stop(): Promise<void> {
    consoleOutput.warning('Stopping Camille server...');
    logger.logServerEvent('server_stopping');
    
    this.status.isRunning = false;
    
    // Stop the API server
    if (this.apiServer) {
      try {
        await this.apiServer.stop();
        consoleOutput.info(chalk.gray('API server stopped'));
      } catch (error) {
        logger.error('Failed to stop API server', { error });
      }
    }
    
    // Stop Supastate sync service if running
    if (this.supastateSyncService) {
      try {
        this.supastateSyncService.stopAutoSync();
        consoleOutput.info(chalk.gray('Supastate sync stopped'));
      } catch (error) {
        logger.error('Failed to stop Supastate sync', { error });
      }
    }
    
    // Close SupastateStorageProvider if active
    if (this.supastateProvider) {
      try {
        await this.supastateProvider.close();
        consoleOutput.info(chalk.gray('Supastate provider closed'));
      } catch (error) {
        logger.error('Failed to close Supastate provider', { error });
      }
    }
    
    // Close all watchers
    for (const [_, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
    this.watchedDirectories.clear();
    
    // Close config watcher
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = undefined;
    }
    
    // Close pipe server
    if (this.pipeServer) {
      this.pipeServer.close();
      this.pipeServer = undefined;
      
      // Remove the pipe file
      if (fs.existsSync(this.pipePath)) {
        fs.unlinkSync(this.pipePath);
      }
    }
    
    await this.indexQueue.onIdle();
    
    consoleOutput.success('✅ Camille server stopped');
    logger.logServerEvent('server_stopped');
  }

  /**
   * Formats graph query results as text for display
   */
  private formatGraphResultsAsText(results: any): string {
    let text = `Graph Query Results\n`;
    text += `══════════════════════════════════════════════════\n\n`;
    text += `Query: ${results.query}\n`;
    text += `Results found: ${results.resultCount}\n\n`;
    
    if (results.resultCount === 0) {
      text += `No results found.\n`;
    } else if (results.resultCount === 1 && Object.keys(results.results[0]).length === 1) {
      // Single value result (like COUNT)
      const key = Object.keys(results.results[0])[0];
      const value = results.results[0][key];
      text += `${key}: ${value}\n`;
    } else {
      // Multiple results or complex objects
      results.results.forEach((row: any, index: number) => {
        if (index < 50) { // Limit display to first 50 results
          text += `Result ${index + 1}:\n`;
          for (const [key, value] of Object.entries(row)) {
            if (typeof value === 'object' && value !== null) {
              text += `  ${key}:\n`;
              for (const [subKey, subValue] of Object.entries(value as any)) {
                text += `    ${subKey}: ${subValue}\n`;
              }
            } else {
              text += `  ${key}: ${value}\n`;
            }
          }
          text += `\n`;
        }
      });
      
      if (results.resultCount > 50) {
        text += `... and ${results.resultCount - 50} more results\n\n`;
      }
    }
    
    text += `\nGraph Statistics:\n`;
    text += `• Nodes: ${results.indexStatus.nodeCount}\n`;
    text += `• Edges: ${results.indexStatus.edgeCount}\n`;
    text += `• Status: ${results.indexStatus.ready ? 'Ready' : 'Indexing'}\n`;
    
    return text;
  }

  /**
   * Process pending edges in second pass after all nodes are indexed
   */
  private async processPendingEdges(): Promise<void> {
    // Skip edge processing if Supastate is enabled
    const config = this.configManager.getConfig();
    if (config.supastate?.enabled) {
      logger.debug('Skipping edge processing - Supastate is enabled');
      return;
    }
    
    if (this.isProcessingEdges || !this.edgeResolver) {
      return;
    }
    
    this.isProcessingEdges = true;
    
    try {
      // Build import maps from parsed files
      this.edgeResolver.buildImportMaps(this.parsedFiles);
      
      // Convert old format to new format
      const pendingEdges: PendingEdge[] = [];
      
      for (const [filePath, edges] of this.pendingEdges) {
        for (const edge of edges) {
          // Extract target info from ID format: "path/to/file:type:name:line"
          const targetParts = edge.target.split(':');
          if (targetParts.length >= 4) {
            const targetFile = targetParts[0];
            const targetType = targetParts[1];
            const targetName = targetParts[2];
            
            pendingEdges.push({
              sourceId: edge.source,
              targetName,
              targetType,
              targetFile: targetFile === edge.source.split(':')[0] ? undefined : targetFile,
              relationship: edge.relationship,
              metadata: edge.metadata,
              receiver: edge.metadata?.receiver,
              importSource: edge.metadata?.importSource
            });
          }
        }
      }
      
      logger.info('Starting edge resolution with new resolver', {
        pendingCount: pendingEdges.length,
        fileCount: this.pendingEdges.size
      });
      
      // Resolve edges using the new resolver
      const stats = await this.edgeResolver.resolveEdges(pendingEdges);
      
      // Clear pending edges after processing
      this.pendingEdges.clear();
      this.parsedFiles = [];
      
      // Update graph statistics
      this.status.graphIndexing.edgeCount = await this.graphDB.getEdgeCount();
      
      logger.info('✅ Edge resolution complete', {
        ...stats,
        totalEdgeCount: this.status.graphIndexing.edgeCount
      });
      
    } catch (error) {
      logger.error('❌ Error processing pending edges', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
    } finally {
      this.isProcessingEdges = false;
    }
  }

  /**
   * Gets the current server status
   */
  public getStatus(): ServerStatus {
    return {
      ...this.status,
      indexSize: this.embeddingsIndex.getIndexSize(),
      queueSize: this.indexQueue.size,
      watchedDirectories: Array.from(this.watchedDirectories),
      graphIndexing: {
        ...this.status.graphIndexing,
        isReady: this.status.graphIndexing.isReady,
        // Note: nodeCount and edgeCount would need to be tracked or queried from Kuzu
        // For now, we'll keep the status values
      }
    };
  }

  /**
   * Gets the embeddings index
   */
  public getEmbeddingsIndex(): EmbeddingsIndex {
    return this.embeddingsIndex;
  }

  /**
   * Gets the graph database
   */
  public getGraphDatabase(): KuzuGraphDB {
    return this.graphDB;
  }

  /**
   * Gets the unified search instance
   */
  public getUnifiedSearch(): CodeUnifiedSearch | undefined {
    return this.unifiedSearch;
  }

  /**
   * Gets the Supastate sync service instance
   */
  public getSupastateSyncService(): SupastateSyncService | undefined {
    return this.supastateSyncService;
  }

  /**
   * Starts the named pipe server for MCP communication
   */
  private async startPipeServer(): Promise<void> {
    // Remove existing pipe if it exists
    if (fs.existsSync(this.pipePath)) {
      fs.unlinkSync(this.pipePath);
    }

    // Create the named pipe server
    this.pipeServer = net.createServer((socket) => {
      const clientId = Date.now();
      logger.info('MCP client connected via named pipe', { clientId, pipePath: this.pipePath });
      
      // Also log to dedicated MCP file
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] CLIENT CONNECTED: ${clientId}\n`);
      
      let buffer = '';
      let requestCount = 0;
      
      socket.on('data', async (data) => {
        const dataStr = data.toString();
        buffer += dataStr;
        
        // Log raw data received
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] RAW DATA (${data.length} bytes): ${dataStr.substring(0, 200)}...\n`);
        
        const lines = buffer.split('\n');
        
        // Process complete lines
        while (lines.length > 1) {
          const line = lines.shift()!;
          if (line.trim()) {
            requestCount++;
            const requestId = `${clientId}-${requestCount}`;
            
            fs.appendFileSync('/tmp/camille-mcp-server.log', 
              `[${new Date().toISOString()}] [${requestId}] PROCESSING LINE: ${line}\n`);
            
            try {
              const request = JSON.parse(line);
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] PARSED REQUEST: ${JSON.stringify(request)}\n`);
              
              logger.info('MCP request received', { requestId, method: request.method, id: request.id });
              
              const response = await this.handleMCPRequest(request);
              
              // Handle null responses (for notifications)
              if (response === null) {
                fs.appendFileSync('/tmp/camille-mcp-server.log', 
                  `[${new Date().toISOString()}] [${requestId}] NO RESPONSE (notification)\n`);
                continue;
              }
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] SENDING RESPONSE: ${JSON.stringify(response)}\n`);
              
              logger.info('MCP response sent', { requestId, hasResult: !!response?.result, hasError: !!response?.error });
              
              socket.write(JSON.stringify(response) + '\n');
            } catch (error) {
              logger.error('Error handling MCP request', { requestId, error });
              
              fs.appendFileSync('/tmp/camille-mcp-server.log', 
                `[${new Date().toISOString()}] [${requestId}] ERROR: ${error}\n${error instanceof Error ? error.stack : ''}\n`);
              
              const errorResponse = {
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : 'Unknown error'
                },
                id: null
              };
              socket.write(JSON.stringify(errorResponse) + '\n');
            }
          }
        }
        
        // Keep the last incomplete line in buffer
        buffer = lines[0];
      });
      
      socket.on('error', (error: Error) => {
        logger.error('Named pipe socket error', { clientId, error });
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] SOCKET ERROR: ${error}\n`);
      });
      
      socket.on('close', () => {
        logger.info('MCP client disconnected', { clientId });
        fs.appendFileSync('/tmp/camille-mcp-server.log', 
          `[${new Date().toISOString()}] [${clientId}] CLIENT DISCONNECTED\n\n`);
      });
    });

    // Listen on the named pipe
    this.pipeServer.listen(this.pipePath, () => {
      consoleOutput.info(chalk.gray(`MCP pipe server listening on: ${this.pipePath}`));
      logger.info('Named pipe server started', { pipePath: this.pipePath });
    });

    this.pipeServer.on('error', (error: Error) => {
      logger.error('Named pipe server error', error);
      consoleOutput.error(`Failed to start pipe server: ${error}`);
    });
  }

  /**
   * Handles MCP requests received via named pipe
   */
  private async handleMCPRequest(request: any): Promise<any> {
    const startTime = Date.now();
    logger.debug('Handling MCP request', { method: request.method, id: request.id });
    
    fs.appendFileSync('/tmp/camille-mcp-server.log', 
      `[${new Date().toISOString()}] HANDLE MCP REQUEST: ${request.method} (id: ${request.id})\n`);
    
    // Use the MCP protocol server to handle all protocol messages
    if (!this.mcpProtocolServer) {
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] INITIALIZING MCP PROTOCOL SERVER\n`);
      const { MCPProtocolServer } = require('./mcp-protocol');
      const { TOOLS } = require('./mcp-server');
      
      // Create MCP protocol server
      this.mcpProtocolServer = new MCPProtocolServer(
        { name: 'camille', version: '0.1.0' },
        { tools: { listChanged: true } }
      );
      
      // Register tools
      this.mcpProtocolServer.registerTool(TOOLS.searchCode, async (args: any) => {
        const result = await this.handleSearchCode(args);
        return result && result.result ? result.result : result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.validateChanges, async (args: any) => {
        const { CamilleHook } = require('./hook');
        const hook = new CamilleHook();
        const result = await this.handleValidateChanges(args, hook);
        return result && result.result ? result.result : result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.getStatus, async (args: any) => {
        const result = await this.handleGetStatus(args);
        return result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.recallMemory, async (args: any) => {
        const { CamilleMCPServer } = require('./mcp-server');
        const mcpServer = new CamilleMCPServer();
        const result = await mcpServer.handleRecallMemory(args);
        return result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.retrieveChunk, async (args: any) => {
        const { CamilleMCPServer } = require('./mcp-server');
        const mcpServer = new CamilleMCPServer();
        const result = await mcpServer.handleRetrieveChunk(args);
        return result;
      });
      
      this.mcpProtocolServer.registerTool(TOOLS.graphQuery, async (args: any) => {
        const result = await this.handleGraphQuery(args);
        return result;
      });
    }
    
    // Handle message through protocol server
    try {
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] CALLING handleMessage for: ${request.method}\n`);
      
      const response = await this.mcpProtocolServer.handleMessage(request);
      const duration = Date.now() - startTime;
      
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] HANDLE MCP COMPLETE: ${request.method} took ${duration}ms, response: ${JSON.stringify(response)}\n`);
      
      logger.debug('MCP request handled', { method: request.method, duration, hasResult: response ? !!response.result : false });
      
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      fs.appendFileSync('/tmp/camille-mcp-server.log', 
        `[${new Date().toISOString()}] HANDLE MCP ERROR: ${request.method} failed after ${duration}ms: ${error}\n`);
      
      throw error;
    }
  }
  
  private mcpProtocolServer: any;

  /**
   * Handles code search requests
   */
  private async handleSearchCode(args: any): Promise<any> {
    const { 
      query, 
      limit = 10, 
      responseFormat = 'both',
      includeDependencies = true,
      directory
    } = args;
    
    try {
      // If Supastate is enabled, use Supastate search
      if (this.supastateProvider) {
        logger.info('Using Supastate for search', { query, limit });
        
        const searchResults = await this.supastateProvider.searchMemories(query, limit);
        
        // Convert Supastate results to expected format
        const results = searchResults.map(result => ({
          path: result.metadata?.filePath || 'unknown',
          similarity: result.score,
          content: result.content,
          summary: result.metadata?.summary,
          lineMatches: [],
          dependencies: undefined,
          graphMatches: undefined
        }));
        
        const jsonResult: any = {
          results: results.map((result: any) => {
            const relativePath = result.path === 'unknown' ? result.path : path.relative(process.cwd(), result.path);
            return {
              path: relativePath,
              similarity: result.similarity.toFixed(3),
              summary: result.summary || 'No summary available',
              preview: result.content.substring(0, 200) + '...',
              lineMatches: result.lineMatches
            };
          }),
          totalFiles: results.length,
          indexStatus: {
            ready: true,
            filesIndexed: results.length,
            isIndexing: false,
            graphReady: false,
            graphIndexing: false
          },
          queryAnalysis: {
            includeDependencies: false
          },
          warning: 'Using Supastate search - graph features disabled'
        };
        
        // Format response based on requested format
        if (responseFormat === 'json') {
          return jsonResult;
        } else if (responseFormat === 'text') {
          return this.formatSearchResultsAsText(query, jsonResult);
        } else {
          return {
            content: [
              {
                type: 'text',
                text: this.formatSearchResultsAsText(query, jsonResult)
              }
            ],
            data: jsonResult
          };
        }
      }
      
      // Original local search
      const unifiedSearch = this.unifiedSearch || new CodeUnifiedSearch(
        this.embeddingsIndex,
        this.graphDB,
        this.openaiClient
      );

      // Perform vector search
      const searchOptions: CodeSearchOptions = {
        limit,
        includeDependencies,
        directory
      };
      
      const results = await unifiedSearch.search(query, searchOptions);
      
      const jsonResult: any = {
        results: results.map((result: EnhancedSearchResult) => {
          const relativePath = path.relative(process.cwd(), result.path);
          const formattedResult: any = {
            path: relativePath,
            similarity: result.similarity.toFixed(3),
            summary: result.summary || 'No summary available',
            preview: result.content.substring(0, 200) + '...',
            lineMatches: result.lineMatches?.map(match => ({
              location: `${relativePath}:${match.lineNumber}`,
              lineNumber: match.lineNumber,
              line: match.line,
              snippet: match.snippet
            }))
          };

          // Include dependency information if available
          if (result.dependencies) {
            formattedResult.dependencies = result.dependencies;
          }

          // Include graph matches if available
          if (result.graphMatches) {
            formattedResult.graphMatches = result.graphMatches.map(match => ({
              node: {
                ...match.node,
                file: path.relative(process.cwd(), match.node.file)
              },
              relationshipCount: match.relationships.edges.length
            }));
          }

          return formattedResult;
        }),
        totalFiles: this.embeddingsIndex.getIndexSize(),
        indexStatus: {
          ready: this.embeddingsIndex.isIndexReady(),
          filesIndexed: this.embeddingsIndex.getIndexSize(),
          isIndexing: this.status.isIndexing,
          graphReady: this.status.graphIndexing.isReady,
          graphIndexing: this.status.graphIndexing.isIndexing
        },
        queryAnalysis: {
          includeDependencies
        }
      };
      
      // Add warning if still indexing
      if (!this.embeddingsIndex.isIndexReady()) {
        jsonResult.warning = 'Index is still building. Results may be incomplete.';
        logger.info('Search performed while indexing', { 
          query, 
          resultsFound: results.length,
          filesIndexedSoFar: this.embeddingsIndex.getIndexSize() 
        });
      }
      
      // Format response based on requested format
      if (responseFormat === 'json') {
        return jsonResult;
      } else if (responseFormat === 'text') {
        return this.formatSearchResultsAsText(query, jsonResult);
      } else {
        // 'both' format - MCP expects 'content' field for display
        return {
          content: [
            {
              type: 'text',
              text: this.formatSearchResultsAsText(query, jsonResult)
            }
          ],
          // Also include structured data for programmatic access
          data: jsonResult
        };
      }
    } catch (error) {
      throw error; // Let MCP protocol handle errors
    }
  }
  
  /**
   * Handles graph query requests
   */
  private async handleGraphQuery(args: any): Promise<any> {
    const { query, explain = false } = args;
    
    try {
      // Check if Supastate is enabled
      const config = this.configManager.getConfig();
      if (config.supastate?.enabled) {
        return {
          error: 'Graph queries are disabled when Supastate is enabled',
          hint: 'Graph query API endpoints will be available in a future update'
        };
      }
      
      // Ensure graph database is initialized
      if (!this.graphDB) {
        return {
          error: 'Graph database not initialized. Please restart the Camille server.',
          hint: 'The graph database needs to be running to execute Cypher queries.'
        };
      }
      
      // Validate query
      if (!query || typeof query !== 'string') {
        return {
          error: 'Invalid query. Please provide a valid Cypher query string.'
        };
      }
      
      logger.info('Executing graph query', { query, explain });
      
      // If explain mode, just return the query plan
      if (explain) {
        // For now, just return the query as the plan
        // In the future, we could add actual query plan analysis
        return {
          query,
          plan: 'Query execution plan not yet implemented',
          hint: 'Remove explain parameter to execute the query'
        };
      }
      
      // Execute the Cypher query
      const results = await this.graphDB.query(query);
      
      // Format results for better readability
      const formattedResults = results.map((row: any) => {
        // Handle different result formats from Cypher
        const formatted: any = {};
        for (const [key, value] of Object.entries(row)) {
          if (value && typeof value === 'object' && 'id' in value) {
            // This is a node - extract key properties
            formatted[key] = {
              id: (value as any).id,
              name: (value as any).name,
              type: (value as any).type,
              file: (value as any).file,
              line: (value as any).line
            };
          } else if (value && typeof value === 'object' && 'label' in value) {
            // This is an edge
            formatted[key] = {
              type: (value as any).label,
              source: (value as any).source,
              target: (value as any).target
            };
          } else {
            // Simple value
            formatted[key] = value;
          }
        }
        return formatted;
      });
      
      // Format response for MCP
      const jsonResult = {
        query,
        resultCount: results.length,
        results: formattedResults,
        indexStatus: {
          ready: this.graphDB.isReady(),
          nodeCount: await this.graphDB.getNodeCount(),
          edgeCount: await this.graphDB.getEdgeCount()
        }
      };
      
      // Return with content field for MCP display
      return {
        content: [
          {
            type: 'text',
            text: this.formatGraphResultsAsText(jsonResult)
          }
        ],
        // Also include structured data for programmatic access
        data: jsonResult
      };
      
    } catch (error) {
      logger.error('Graph query error', { query, error });
      
      // Provide helpful error messages for common issues
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      let hint = '';
      
      if (errorMessage.includes('Parser exception')) {
        hint = 'Check your Cypher syntax. Common issues: missing quotes, incorrect property names, or invalid operators.';
      } else if (errorMessage.includes('not found')) {
        hint = 'The property or label might not exist. Use MATCH (n:CodeObject) RETURN DISTINCT keys(n) to see available properties.';
      } else if (errorMessage.includes('timeout')) {
        hint = 'Query took too long. Try adding LIMIT or more specific WHERE clauses.';
      }
      
      return {
        error: `Graph query failed: ${errorMessage}`,
        query,
        hint
      };
    }
  }
  
  private formatSearchResultsAsText(query: string, results: any): string {
    let text = `Camille Code Search Results\n`;
    text += `Query: "${query}"\n`;
    text += `${'═'.repeat(50)}\n\n`;
    
    if (results.warning) {
      text += `WARNING: ${results.warning}\n\n`;
    }
    
    text += `Found ${results.results.length} relevant files (out of ${results.totalFiles} total)\n\n`;
    
    results.results.forEach((result: any, index: number) => {
      text += `${index + 1}. ${result.path} (similarity: ${result.similarity})\n`;
      text += `   Summary: ${result.summary}\n`;
      text += `   Preview: ${result.preview}\n`;
      
      // Include line matches if available
      if (result.lineMatches && result.lineMatches.length > 0) {
        text += `\n   Relevant locations:\n`;
        result.lineMatches.forEach((match: any) => {
          text += `   • ${match.location}: ${match.line}\n`;
        });
      }

      // Include dependency information if available
      if (result.dependencies) {
        const deps = result.dependencies;
        if (deps.imports.length > 0 || deps.calls.length > 0 || deps.usedBy.length > 0) {
          text += `\n   Dependencies:\n`;
          
          if (deps.imports.length > 0) {
            text += `   • Imports: ${deps.imports.slice(0, 3).join(', ')}${deps.imports.length > 3 ? '...' : ''}\n`;
          }
          
          if (deps.calls.length > 0) {
            text += `   • Calls: ${deps.calls.slice(0, 2).map((c: any) => c.function).join(', ')}${deps.calls.length > 2 ? '...' : ''}\n`;
          }
          
          if (deps.usedBy.length > 0) {
            text += `   • Used by: ${deps.usedBy.slice(0, 2).map((u: any) => `${u.function} (${u.file})`).join(', ')}${deps.usedBy.length > 2 ? '...' : ''}\n`;
          }
        }
      }

      // Include graph matches if available
      if (result.graphMatches && result.graphMatches.length > 0) {
        text += `\n   Code structure:\n`;
        result.graphMatches.forEach((match: any) => {
          text += `   • ${match.node.type}: ${match.node.name} (line ${match.node.line})`;
          if (match.relationshipCount > 0) {
            text += ` - ${match.relationshipCount} relationships`;
          }
          text += `\n`;
        });
      }
      
      text += `\n`;
    });
    
    text += `\nIndex Status: ${results.indexStatus.ready ? 'Ready' : 'Indexing...'}`;
    text += ` (${results.indexStatus.filesIndexed} files indexed)`;
    
    return text;
  }

  /**
   * Handles validation requests
   */
  private async handleValidateChanges(args: any, hook: any): Promise<any> {
    const { filePath, changes, changeType, responseFormat = 'both' } = args;
    
    try {
      const mockInput = {
        session_id: 'mcp-validation',
        transcript_path: '',
        hook_event_name: 'PreToolUse',
        tool: {
          name: changeType === 'create' ? 'Write' : 'Edit',
          input: {
            file_path: filePath,
            ...(changeType === 'create' 
              ? { content: changes }
              : { old_string: '', new_string: changes })
          }
        }
      };

      const result = await hook.processHook(mockInput);
      
      const jsonResult = {
        approved: result.decision === 'approve',
        reason: result.reason,
        needsChanges: result.decision === 'block',
        details: this.parseValidationDetails(result.reason || '')
      };

      // Format response based on requested format
      if (responseFormat === 'json') {
        return jsonResult;
      } else if (responseFormat === 'text') {
        return this.formatValidationResultAsText(filePath, changeType, jsonResult);
      } else {
        // 'both' format - MCP expects 'content' field for display
        return {
          content: [
            {
              type: 'text',
              text: this.formatValidationResultAsText(filePath, changeType, jsonResult)
            }
          ],
          // Also include structured data for programmatic access
          data: jsonResult
        };
      }
    } catch (error) {
      throw error; // Let MCP protocol handle errors
    }
  }
  
  private formatValidationResultAsText(filePath: string, changeType: string, result: any): string {
    let text = `Camille Security & Compliance Report\n`;
    text += `${'═'.repeat(50)}\n\n`;
    text += `File: ${filePath}\n`;
    text += `Change Type: ${changeType}\n`;
    text += `Status: ${result.approved ? 'APPROVED' : 'NEEDS CHANGES'}\n\n`;
    
    if (result.reason) {
      text += `Summary:\n${result.reason}\n\n`;
    }
    
    if (result.details) {
      if (result.details.securityIssues?.length > 0) {
        text += `Security Issues:\n`;
        result.details.securityIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.complianceIssues?.length > 0) {
        text += `Compliance Issues:\n`;
        result.details.complianceIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.qualityIssues?.length > 0) {
        text += `Code Quality Issues:\n`;
        result.details.qualityIssues.forEach((issue: string) => {
          text += `  • ${issue}\n`;
        });
        text += '\n';
      }
      
      if (result.details.suggestedFix) {
        text += `Suggested Fix:\n${result.details.suggestedFix}\n`;
      }
    }
    
    return text.trim();
  }
  
  /**
   * Handles status requests
   */
  private async handleGetStatus(args: any): Promise<any> {
    const { responseFormat = 'both' } = args;
    
    const jsonResult = {
      running: true,
      indexReady: this.embeddingsIndex.isIndexReady(),
      indexing: this.status.isIndexing,
      filesIndexed: this.embeddingsIndex.getIndexSize(),
      queueSize: this.indexQueue.size
    };
    
    // Format response based on requested format
    if (responseFormat === 'json') {
      return jsonResult;
    } else if (responseFormat === 'text') {
      return this.formatStatusAsText(jsonResult);
    } else {
      // 'both' format - MCP expects 'content' field for display
      return {
        content: [
          {
            type: 'text',
            text: this.formatStatusAsText(jsonResult)
          }
        ],
        // Also include structured data for programmatic access
        data: jsonResult
      };
    }
  }
  
  private formatStatusAsText(status: any): string {
    let text = `Camille Server Status\n`;
    text += `${'═'.repeat(50)}\n\n`;
    
    text += `Server: ${status.running ? 'Running' : 'Stopped'}\n`;
    text += `Index: ${status.indexReady ? 'Ready' : 'Building...'}\n`;
    text += `Status: ${status.indexing ? 'Indexing files...' : 'Idle'}\n\n`;
    
    text += `Files Indexed: ${status.filesIndexed}\n`;
    if (status.queueSize > 0) {
      text += `Queue: ${status.queueSize} files pending\n`;
    }
    
    if (!status.indexReady) {
      text += `\nNote: Search results may be incomplete until indexing finishes.\n`;
    }
    
    return text.trim();
  }

  /**
   * Parses validation details from reason string
   */
  private parseValidationDetails(reason: string): any {
    const details = {
      securityIssues: [] as string[],
      complianceIssues: [] as string[],
      qualityIssues: [] as string[]
    };

    const lines = reason.split('\n');
    for (const line of lines) {
      if (line.includes('Security:')) {
        details.securityIssues.push(line.replace('Security:', '').trim());
      } else if (line.includes('Compliance:')) {
        details.complianceIssues.push(line.replace('Compliance:', '').trim());
      } else if (line.includes('Quality:')) {
        details.qualityIssues.push(line.replace('Quality:', '').trim());
      }
    }

    return details;
  }

  /**
   * Performs initial indexing of all files
   */
  private async performInitialIndexing(directory: string): Promise<void> {
    this.spinner = isQuietMode() ? null : ora('Discovering files...').start();
    this.status.isIndexing = true;
    logger.logServerEvent('indexing_started', { directory });
    
    try {
      // Find all files to index
      const files = await glob('**/*', {
        cwd: directory,
        nodir: true,
        absolute: true,
        ignore: this.configManager.getConfig().ignorePatterns
      });
      
      const filesToIndex = files.filter(file => this.fileFilter.shouldIndex(file));
      
      if (filesToIndex.length === 0) {
        if (this.spinner) this.spinner.succeed('No files to index');
        consoleOutput.info('No files to index');
        this.embeddingsIndex.setReady(true);
        return;
      }
      
      if (this.spinner) this.spinner.text = `Indexing ${filesToIndex.length} files...`;
      logger.info(`Starting to index ${filesToIndex.length} files`);
      
      // Add all files to the queue
      let processed = 0;
      let skipped = 0;
      for (const file of filesToIndex) {
        this.indexQueue.add(async () => {
          // Check if file needs indexing (use cache if available)
          if (this.embeddingsIndex.needsReindex(file)) {
            await this.indexFile(file, directory);
          } else {
            skipped++;
            logger.debug('Using cached embedding', { path: file });
            
            // Still need to parse code structure for graph database even if embeddings are cached
            logger.info('Parsing code structure for cached file', { path: file });
            const content = fs.readFileSync(file, 'utf8');
            await this.parseAndIndexCodeStructure(file, content);
          }
          processed++;
          if (this.spinner) {
            const skipText = skipped > 0 ? ` (${skipped} cached)` : '';
            this.spinner.text = `Indexing files... (${processed}/${filesToIndex.length})${skipText}`;
          }
        });
      }
      
      // Wait for all indexing to complete
      await this.indexQueue.onIdle();
      
      const newlyIndexed = filesToIndex.length - skipped;
      const message = skipped > 0 
        ? `Indexed ${newlyIndexed} new files, used cache for ${skipped} files`
        : `Indexed ${filesToIndex.length} files`;
      
      if (this.spinner) this.spinner.succeed(message);
      consoleOutput.success(message);
      logger.logServerEvent('indexing_completed', { 
        directory, 
        totalFiles: filesToIndex.length,
        newlyIndexed,
        cachedFiles: skipped
      });
      this.embeddingsIndex.setReady(true);
      
      // Process pending edges in second pass
      if (this.pendingEdges.size > 0) {
        logger.info('Processing pending edges after initial indexing', {
          pendingFiles: this.pendingEdges.size
        });
        await this.processPendingEdges();
      }
      
    } catch (error) {
      if (this.spinner) this.spinner.fail(`Indexing failed: ${error}`);
      consoleOutput.error(`Indexing failed: ${error}`);
      logger.error('Indexing failed', error, { directory });
      throw error;
    } finally {
      this.status.isIndexing = false;
    }
  }

  /**
   * Sets up file watcher for changes
   */
  private setupFileWatcher(directory: string): void {
    const watcher = chokidar.watch(directory, {
      ignored: [
        /(^|[\/\\])\../, // dot files
        ...this.configManager.getConfig().ignorePatterns
      ],
      persistent: true,
      ignoreInitial: true
    });
    
    // Store watcher
    this.watchers.set(directory, watcher);
    
    // Handle file changes
    watcher.on('change', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        consoleOutput.debug(`File changed: ${path.relative(directory, filePath)}`);
        logger.info('File change detected', { path: filePath, directory });
        this.indexQueue.add(() => this.reindexFile(filePath, directory));
      }
    });
    
    // Handle new files
    watcher.on('add', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        consoleOutput.debug(`File added: ${path.relative(directory, filePath)}`);
        logger.info('New file detected', { path: filePath, directory });
        this.indexQueue.add(() => this.indexFile(filePath, directory));
      }
    });
    
    // Handle deleted files
    watcher.on('unlink', (filePath) => {
      consoleOutput.debug(`File deleted: ${path.relative(directory, filePath)}`);
      logger.info('File deleted', { path: filePath, directory });
      this.embeddingsIndex.removeFile(filePath);
    });
  }

  /**
   * Indexes a single file
   */
  private async indexFile(filePath: string, projectPath?: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Skip very large files
      const maxSize = this.configManager.getConfig().maxIndexFileSize || 500000;
      if (content.length > maxSize) {
        consoleOutput.warning(`Skipping large file: ${path.basename(filePath)} (${content.length} bytes > ${maxSize} bytes)`);
        logger.logFileOperation('skip_large_file', filePath, true);
        logger.info('Skipped large file during indexing', { 
          path: filePath, 
          size: content.length, 
          maxSize 
        });
        return;
      }
      
      // If Supastate is enabled, send raw file for server-side processing
      if (this.supastateProvider) {
        logger.info('Using Supastate for server-side processing', { path: filePath });
        
        // Determine language from file extension
        const ext = path.extname(filePath).substring(1);
        const language = ext || 'plaintext';
        
        // Determine which watched directory this file belongs to
        if (!projectPath) {
          for (const watchedDir of this.getWatchedDirectories()) {
            if (filePath.startsWith(watchedDir)) {
              projectPath = watchedDir;
              break;
            }
          }
          // Fallback to current directory if not in a watched directory
          projectPath = projectPath || process.cwd();
        }
        
        // Send to Supastate for processing
        await this.supastateProvider.addCodeFile(projectPath, {
          path: filePath,
          content: content,
          language: language,
          lastModified: fs.statSync(filePath).mtime.toISOString(),
        });
        
        logger.info('File sent to Supastate for processing', { path: filePath });
        
        // Still parse code structure locally for immediate graph availability
        await this.parseAndIndexCodeStructure(filePath, content);
        
        return;
      }
      
      // Original local processing (only if Supastate is not enabled)
      logger.debug('Using local embedding generation', { path: filePath });
      
      // Generate summary for the file
      logger.debug('Generating summary for file', { path: filePath, size: content.length });
      const summary = await this.generateFileSummary(filePath, content);
      
      // Generate embedding
      const embeddingInput = `${path.basename(filePath)}\n${summary}\n${content.substring(0, 8000)}`;
      logger.debug('Generating embedding for file', { path: filePath, inputSize: embeddingInput.length });
      const embedding = await this.openaiClient!.generateEmbedding(embeddingInput);
      
      // Store in index
      this.embeddingsIndex.addEmbedding(filePath, embedding, content, summary);
      
      // Parse code structure and store in graph database
      await this.parseAndIndexCodeStructure(filePath, content);
      
      logger.info('File indexed successfully', { path: filePath, size: content.length });
      
    } catch (error) {
      consoleOutput.error(`Failed to index ${filePath}: ${error}`);
      logger.error(`Failed to index file`, error, { filePath });
    }
  }

  /**
   * Parse and index code structure for graph database
   */
  private async parseAndIndexCodeStructure(filePath: string, content: string): Promise<void> {
    try {
      logger.debug('Starting code parsing', { path: filePath });
      const parsedFile = await codeParser.parseFile(filePath, content);
      
      if (parsedFile) {
        logger.debug('Code parsing successful', { 
          path: filePath, 
          nodesFound: parsedFile.nodes.length,
          edgesFound: parsedFile.edges.length,
          importsFound: parsedFile.imports.length,
          exportsFound: parsedFile.exports.length
        });
        
        // Store parsed file for edge resolver
        this.parsedFiles.push(parsedFile);
        
        // If using Supastate, skip ALL graph operations
        if (this.supastateProvider) {
          logger.info('Skipping graph database operations - using Supastate', { 
            path: filePath,
            reason: 'Code graphs disabled when Supastate is enabled'
          });
          return;
        }
        
        // Store nodes and edges in graph database
        if (parsedFile.nodes.length > 0) {
          logger.debug('Adding nodes to graph database', { 
            path: filePath, 
            nodeCount: parsedFile.nodes.length,
            nodeTypes: parsedFile.nodes.map(n => `${n.type}:${n.name}`).slice(0, 5)
          });
          
          // Generate embeddings for each node
          const nodesWithEmbeddings = await Promise.all(
            parsedFile.nodes.map(async (node) => {
              try {
                // Generate embedding for node name
                const nameEmbedding = await this.openaiClient!.generateEmbedding(
                  `${node.type} ${node.name}`
                );
                
                // Generate embedding for node context (includes type, name, and file)
                const contextString = `${node.type} ${node.name} in ${path.basename(node.file)}`;
                const summaryEmbedding = await this.openaiClient!.generateEmbedding(contextString);
                
                return {
                  ...node,
                  name_embedding: nameEmbedding,
                  summary_embedding: summaryEmbedding
                };
              } catch (error) {
                logger.warn('Failed to generate embeddings for node', { 
                  nodeId: node.id, 
                  error 
                });
                // Return node without embeddings if generation fails
                return node;
              }
            })
          );
          
          await this.graphDB.addNodes(nodesWithEmbeddings);
          logger.debug('Nodes added successfully with embeddings', { 
            path: filePath, 
            nodeCount: parsedFile.nodes.length 
          });
        }
        
        if (parsedFile.edges.length > 0) {
          logger.info('EDGES DETECTED - Two-pass indexing needed', { 
            path: filePath, 
            edgeCount: parsedFile.edges.length,
            edges: parsedFile.edges.slice(0, 3) // Log first 3 edges for debugging
          });
          
          // Store edges for second pass processing
          // We'll process these after ALL nodes have been indexed
          this.pendingEdges.set(filePath, parsedFile.edges);
          
          logger.info('Edges stored for second pass', { 
            path: filePath,
            pendingEdgeFiles: this.pendingEdges.size
          });
        }
        
        logger.debug('Code structure indexed successfully', { 
          path: filePath, 
          nodes: parsedFile.nodes.length,
          edges: parsedFile.edges.length,
          imports: parsedFile.imports.length
        });
      } else {
        logger.debug('No parsed code structure returned', { path: filePath });
      }
    } catch (error) {
      logger.error('Failed to parse code structure', { 
        path: filePath, 
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined
        }
      });
      // Don't fail the entire indexing if code parsing fails
    }
  }

  /**
   * Re-indexes a file if needed
   */
  private async reindexFile(filePath: string, projectPath?: string): Promise<void> {
    if (this.embeddingsIndex.needsReindex(filePath)) {
      logger.info('File needs re-indexing', { path: filePath });
      await this.indexFile(filePath, projectPath);
    } else {
      logger.debug('File unchanged, skipping re-index', { path: filePath });
    }
  }

  /**
   * Sets up config file watching
   */
  private setupConfigWatcher(): void {
    const configPath = path.join(
      process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
      'config.json'
    );
    
    // Store initial config content
    try {
      this.lastConfigContent = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      logger.error('Failed to read initial config', error);
      return;
    }
    
    this.configWatcher = chokidar.watch(configPath, {
      persistent: true,
      ignoreInitial: true
    });
    
    this.configWatcher.on('change', async () => {
      try {
        const newContent = fs.readFileSync(configPath, 'utf8');
        
        // Check if content actually changed (avoid multiple events)
        if (newContent === this.lastConfigContent) {
          return;
        }
        
        this.lastConfigContent = newContent;
        consoleOutput.info(chalk.yellow('Configuration file changed, reloading...'));
        logger.info('Configuration file changed');
        
        // Reload configuration
        const newConfig = JSON.parse(newContent);
        const oldWatchedDirs = new Set(this.watchedDirectories);
        const newWatchedDirs = new Set<string>(newConfig.watchedDirectories || []);
        
        // Find directories to add
        for (const dir of newWatchedDirs) {
          if (!oldWatchedDirs.has(dir)) {
            consoleOutput.info(chalk.blue(`Adding new directory from config: ${dir}`));
            await this.addDirectory(dir);
          }
        }
        
        // Find directories to remove
        for (const dir of oldWatchedDirs) {
          if (!newWatchedDirs.has(dir)) {
            consoleOutput.info(chalk.blue(`Removing directory no longer in config: ${dir}`));
            await this.removeDirectory(dir);
          }
        }
        
        // Update other settings
        const config = this.configManager.getConfig();
        this.fileFilter = new FileFilter(config.ignorePatterns);
        this.llmClient = new LLMClient(config, process.cwd());
        this.openaiClient = new OpenAIClient(this.configManager.getApiKey(), config, process.cwd());
        
        consoleOutput.success('✅ Configuration reloaded');
        logger.info('Configuration reloaded successfully');
      } catch (error) {
        logger.error('Failed to reload configuration', error);
        consoleOutput.error('Failed to reload configuration: ' + error);
      }
    });
    
    consoleOutput.info(chalk.gray('Watching configuration file for changes'));
  }
  
  /**
   * Generates a summary of a file for better search
   */
  private async generateFileSummary(filePath: string, content: string): Promise<string> {
    // Generate a simple summary without using LLM to avoid complexity
    // File summaries are just for search context, not critical
    const ext = path.extname(filePath);
    const basename = path.basename(filePath);
    const lines = content.split('\n').length;
    const chars = content.length;
    
    // Extract first meaningful line (skip comments and empty lines)
    const meaningfulLines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//') && !line.startsWith('#') && !line.startsWith('/*'));
    
    const preview = meaningfulLines[0] || '';
    
    return `${basename} - ${ext.slice(1).toUpperCase() || 'text'} file with ${lines} lines, ${chars} chars. ${preview.substring(0, 100)}`;
  }

  /**
   * Read the first line of a file
   */
  private async readFirstLine(filePath: string): Promise<string> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    
    return new Promise((resolve, reject) => {
      let firstLine = '';
      
      stream.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        if (lines.length > 0) {
          firstLine = lines[0];
          stream.destroy();
          resolve(firstLine);
        }
      });
      
      stream.on('error', reject);
      stream.on('end', () => resolve(firstLine));
    });
  }

  /**
   * Find the project root directory by looking for common project indicators
   */
  private async findProjectRoot(startDir: string): Promise<string | undefined> {
    try {
      let currentDir = startDir;
      const homeDir = os.homedir();
      
      // Don't go above home directory
      while (currentDir.startsWith(homeDir) && currentDir !== homeDir) {
        // Check for common project root indicators
        const indicators = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml'];
        
        for (const indicator of indicators) {
          const indicatorPath = path.join(currentDir, indicator);
          if (fs.existsSync(indicatorPath)) {
            return currentDir;
          }
        }
        
        // Move up one directory
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          break; // Reached root
        }
        currentDir = parentDir;
      }
      
      return undefined;
    } catch (error) {
      logger.error('Error finding project root', { startDir, error });
      return undefined;
    }
  }

  /**
   * Manually trigger second pass edge processing
   * Useful for re-running edge creation after code parser fixes
   */
  public async triggerSecondPass(): Promise<void> {
    logger.info('Manually triggering second pass edge processing');
    
    // First, we need to re-parse all indexed files to get updated edges
    const indexedFiles = this.embeddingsIndex.getIndexedFiles();
    logger.info(`Re-parsing ${indexedFiles.length} files for edge detection`);
    
    // Clear existing pending edges
    this.pendingEdges.clear();
    
    // Re-parse each file to collect edges with the updated parser
    for (const filePath of indexedFiles) {
      try {
        // Skip if not a code file that the parser can handle
        if (!codeParser.canParse(filePath)) {
          continue;
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Determine which watched directory this file belongs to
        let projectPath: string | undefined;
        for (const watchedDir of this.getWatchedDirectories()) {
          if (filePath.startsWith(watchedDir)) {
            projectPath = watchedDir;
            break;
          }
        }
        
        await this.parseAndIndexCodeStructure(filePath, content);
      } catch (error) {
        logger.error('Failed to re-parse file for edges', { filePath, error });
      }
    }
    
    // Now run the second pass
    await this.processPendingEdges();
  }

  /**
   * Index existing Claude transcripts on startup
   */
  private async indexExistingTranscripts(): Promise<void> {
    try {
      logger.info('Starting to index existing Claude transcripts');
      
      // Check if memory is enabled
      const config = this.configManager.getConfig();
      if (!config.memory?.enabled || !config.memory?.transcript?.enabled) {
        logger.info('Memory system disabled, skipping transcript indexing');
        return;
      }

      // Get the transcripts directory
      const transcriptsDir = path.join(os.homedir(), '.claude', 'projects');
      
      if (!fs.existsSync(transcriptsDir)) {
        logger.info('No Claude transcripts directory found');
        return;
      }

      // Import the TranscriptProcessor and checkpoint manager
      const { TranscriptProcessor } = await import('./memory/processors/transcript-processor.js');
      const { TranscriptCheckpointManager } = await import('./memory/databases/transcript-checkpoint.js');
      
      const processor = new TranscriptProcessor();
      const checkpointManager = new TranscriptCheckpointManager(
        path.join(this.configManager.getConfigDir(), 'memory')
      );

      // Find all transcript files (they are .jsonl files in project directories)
      const transcriptFiles = await glob('**/*.jsonl', {
        cwd: transcriptsDir,
        absolute: true
      });

      // Get checkpoint stats before processing
      const statsBefore = checkpointManager.getStats();
      logger.info(`Found ${transcriptFiles.length} transcript files. Already indexed: ${statsBefore.indexed}`);

      // Process each transcript file
      let processed = 0;
      let skipped = 0;
      let errors = 0;

      for (const transcriptPath of transcriptFiles) {
        try {
          // Check if this transcript needs indexing
          if (!checkpointManager.needsIndexing(transcriptPath)) {
            skipped++;
            logger.debug(`Skipping already indexed transcript: ${transcriptPath}`);
            continue;
          }

          // Extract session ID from filename
          const basename = path.basename(transcriptPath, '.jsonl');
          const sessionId = basename;
          
          // Read JSONL file and find the project path (cwd) from any entry
          let projectPath: string | undefined;
          
          try {
            const content = await fs.promises.readFile(transcriptPath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            
            // Parse each line and look for one with a cwd property
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.cwd) {
                  projectPath = entry.cwd;
                  logger.info('Found project path from cwd in transcript', { 
                    transcriptPath, 
                    projectPath 
                  });
                  break;
                }
              } catch (e) {
                // This line wasn't valid JSON, continue to next
              }
            }
          } catch (error) {
            logger.error('Failed to read transcript file', { transcriptPath, error });
          }
          
          if (!projectPath) {
            logger.warn('Could not find cwd in transcript, will NOT use directory name', { 
              transcriptPath 
            });
            // Skip this transcript if we can't determine the project path from cwd
            // This prevents using incorrect project names like "-Users-srao-openai-hook"
            continue;
          }

          logger.info(`Indexing transcript for session ${sessionId} in project ${projectPath}`);

          // Process the transcript
          const result = await processor.processTranscript(
            transcriptPath,
            sessionId,
            projectPath,
            {
              chunkSize: config.memory?.indexing?.chunkSize || 4000,
              chunkOverlap: config.memory?.indexing?.chunkOverlap || 200,
              embeddingModel: config.memory?.indexing?.embeddingModel || 'text-embedding-3-large'
            }
          );
          
          // Mark as indexed in checkpoint
          checkpointManager.markIndexed(transcriptPath, result.chunks);
          
          processed++;
          logger.info(`Indexed transcript: ${result.chunks} chunks, ${result.embeddings} embeddings`);
        } catch (error) {
          errors++;
          logger.error('Failed to index transcript', { 
            transcriptPath, 
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
              name: error.name
            } : error
          });
        }
      }

      logger.info('Completed indexing existing transcripts', {
        total: transcriptFiles.length,
        processed,
        skipped,
        errors
      });

      const statsAfter = checkpointManager.getStats();
      consoleOutput.info(chalk.green(`✅ Indexed ${processed} new transcripts, skipped ${skipped} already indexed`));
      consoleOutput.info(chalk.gray(`Total indexed transcripts: ${statsAfter.indexed} with ${statsAfter.totalChunks} chunks`));
      
    } catch (error) {
      logger.error('Failed to index existing transcripts', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error
      });
    }
  }
}

/**
 * Server manager for running in background
 */
export class ServerManager {
  private static instance?: CamilleServer;
  private static pidFilePath: string = path.join(
    process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
    'server.pid'
  );

  /**
   * Starts the server if not already running
   */
  public static async start(directories: string | string[] = process.cwd()): Promise<CamilleServer> {
    // Check if another server is already running
    if (this.isServerRunning()) {
      throw new Error('Camille server is already running. Use "camille server stop" to stop it first.');
    }
    
    if (!this.instance) {
      this.instance = new CamilleServer();
      await this.instance.start(directories);
      
      // Write PID file
      this.writePidFile();
      logger.info('PID file written', { pid: process.pid, pidFile: this.pidFilePath });
    }
    return this.instance;
  }

  /**
   * Gets the running server instance
   */
  public static getInstance(): CamilleServer | undefined {
    return this.instance;
  }
  
  /**
   * Sets the server instance (used when server starts itself)
   */
  public static setInstance(server: CamilleServer): void {
    this.instance = server;
  }

  /**
   * Stops the server if running
   */
  public static async stop(): Promise<void> {
    // First try to stop the local instance
    if (this.instance) {
      await this.instance.stop();
      this.instance = undefined;
      this.removePidFile();
      return;
    }
    
    // If no local instance, try to stop by PID
    const pid = this.readPidFile();
    if (pid) {
      try {
        // Check if process exists
        process.kill(pid, 0);
        
        // Process exists, try to kill it
        consoleOutput.warning(`Stopping server process (PID: ${pid})...`);
        process.kill(pid, 'SIGTERM');
        
        // Give it time to gracefully shutdown
        let attempts = 0;
        while (attempts < 50) { // 5 seconds
          try {
            process.kill(pid, 0); // Check if still running
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
          } catch {
            // Process no longer exists
            break;
          }
        }
        
        // If still running, force kill
        try {
          process.kill(pid, 0);
          consoleOutput.warning('Server did not stop gracefully, forcing shutdown...');
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone
        }
        
        this.removePidFile();
        consoleOutput.success('✅ Camille server stopped');
      } catch (error: any) {
        if (error.code === 'ESRCH') {
          // Process doesn't exist
          consoleOutput.warning('Server process not found, cleaning up PID file...');
          this.removePidFile();
        } else if (error.code === 'EPERM') {
          // Permission denied
          throw new Error(`Permission denied to stop server process (PID: ${pid})`);
        } else {
          throw error;
        }
      }
    } else {
      consoleOutput.warning('No running Camille server found');
    }
  }
  
  /**
   * Checks if a server is running by checking the PID file
   */
  private static isServerRunning(): boolean {
    const pid = this.readPidFile();
    if (!pid) return false;
    
    try {
      // Check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      // Process doesn't exist, clean up stale PID file
      this.removePidFile();
      return false;
    }
  }
  
  /**
   * Writes the current process PID to file
   */
  private static writePidFile(): void {
    const dir = path.dirname(this.pidFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.pidFilePath, process.pid.toString());
    logger.info('PID file created', { pid: process.pid, file: this.pidFilePath });
  }
  
  /**
   * Reads the PID from file
   */
  private static readPidFile(): number | null {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        const pid = parseInt(fs.readFileSync(this.pidFilePath, 'utf8').trim(), 10);
        return isNaN(pid) ? null : pid;
      }
    } catch (error) {
      logger.error('Failed to read PID file', error);
    }
    return null;
  }
  
  /**
   * Removes the PID file
   */
  private static removePidFile(): void {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        fs.unlinkSync(this.pidFilePath);
      }
    } catch (error) {
      logger.error('Failed to remove PID file', error);
    }
  }
}