/**
 * Server mode implementation for Camille
 * Runs as a background service with file watching and embedding indexing
 */

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { glob } from 'glob';
import PQueue from 'p-queue';
import ora from 'ora';
import chalk from 'chalk';
import { ConfigManager } from './config';
import { OpenAIClient } from './openai-client';
import { EmbeddingsIndex, FileFilter } from './embeddings';
import { EMBEDDING_PROMPT } from './prompts';

/**
 * Server status
 */
export interface ServerStatus {
  isRunning: boolean;
  isIndexing: boolean;
  indexSize: number;
  queueSize: number;
}

/**
 * Camille server class
 */
export class CamilleServer {
  private configManager: ConfigManager;
  private openaiClient: OpenAIClient;
  private embeddingsIndex: EmbeddingsIndex;
  private fileFilter: FileFilter;
  private watcher?: chokidar.FSWatcher;
  private indexQueue: PQueue;
  private status: ServerStatus;
  private spinner?: ora.Ora;

  constructor() {
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    const apiKey = this.configManager.getApiKey();
    
    this.openaiClient = new OpenAIClient(apiKey, config, process.cwd());
    this.embeddingsIndex = new EmbeddingsIndex(this.configManager);
    this.fileFilter = new FileFilter(config.ignorePatterns);
    
    // Queue for processing files with concurrency limit
    this.indexQueue = new PQueue({ concurrency: 3 });
    
    this.status = {
      isRunning: false,
      isIndexing: false,
      indexSize: 0,
      queueSize: 0
    };
  }

  /**
   * Starts the server
   */
  public async start(directory: string = process.cwd()): Promise<void> {
    console.log(chalk.blue('🚀 Starting Camille server...'));
    
    this.status.isRunning = true;
    
    // Initial indexing
    await this.performInitialIndexing(directory);
    
    // Set up file watcher
    this.setupFileWatcher(directory);
    
    console.log(chalk.green('✅ Camille server is running'));
    console.log(chalk.gray(`Watching directory: ${directory}`));
    console.log(chalk.gray(`Indexed files: ${this.embeddingsIndex.getIndexSize()}`));
  }

  /**
   * Stops the server
   */
  public async stop(): Promise<void> {
    console.log(chalk.yellow('Stopping Camille server...'));
    
    this.status.isRunning = false;
    
    if (this.watcher) {
      await this.watcher.close();
    }
    
    await this.indexQueue.onIdle();
    
    console.log(chalk.green('✅ Camille server stopped'));
  }

  /**
   * Gets the current server status
   */
  public getStatus(): ServerStatus {
    return {
      ...this.status,
      indexSize: this.embeddingsIndex.getIndexSize(),
      queueSize: this.indexQueue.size
    };
  }

  /**
   * Gets the embeddings index
   */
  public getEmbeddingsIndex(): EmbeddingsIndex {
    return this.embeddingsIndex;
  }

  /**
   * Performs initial indexing of all files
   */
  private async performInitialIndexing(directory: string): Promise<void> {
    this.spinner = ora('Discovering files...').start();
    this.status.isIndexing = true;
    
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
        this.spinner.succeed('No files to index');
        this.embeddingsIndex.setReady(true);
        return;
      }
      
      this.spinner.text = `Indexing ${filesToIndex.length} files...`;
      
      // Add all files to the queue
      let processed = 0;
      for (const file of filesToIndex) {
        this.indexQueue.add(async () => {
          await this.indexFile(file);
          processed++;
          this.spinner!.text = `Indexing files... (${processed}/${filesToIndex.length})`;
        });
      }
      
      // Wait for all indexing to complete
      await this.indexQueue.onIdle();
      
      this.spinner.succeed(`Indexed ${filesToIndex.length} files`);
      this.embeddingsIndex.setReady(true);
      
    } catch (error) {
      this.spinner?.fail(`Indexing failed: ${error}`);
      throw error;
    } finally {
      this.status.isIndexing = false;
    }
  }

  /**
   * Sets up file watcher for changes
   */
  private setupFileWatcher(directory: string): void {
    this.watcher = chokidar.watch(directory, {
      ignored: [
        /(^|[\/\\])\../, // dot files
        ...this.configManager.getConfig().ignorePatterns
      ],
      persistent: true,
      ignoreInitial: true
    });
    
    // Handle file changes
    this.watcher.on('change', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        console.log(chalk.gray(`File changed: ${path.relative(directory, filePath)}`));
        this.indexQueue.add(() => this.reindexFile(filePath));
      }
    });
    
    // Handle new files
    this.watcher.on('add', (filePath) => {
      if (this.fileFilter.shouldIndex(filePath)) {
        console.log(chalk.gray(`File added: ${path.relative(directory, filePath)}`));
        this.indexQueue.add(() => this.indexFile(filePath));
      }
    });
    
    // Handle deleted files
    this.watcher.on('unlink', (filePath) => {
      console.log(chalk.gray(`File deleted: ${path.relative(directory, filePath)}`));
      this.embeddingsIndex.removeFile(filePath);
    });
  }

  /**
   * Indexes a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Skip very large files
      if (content.length > 100000) {
        console.log(chalk.yellow(`Skipping large file: ${path.basename(filePath)}`));
        return;
      }
      
      // Generate summary for the file
      const summary = await this.generateFileSummary(filePath, content);
      
      // Generate embedding
      const embeddingInput = `${path.basename(filePath)}\n${summary}\n${content.substring(0, 8000)}`;
      const embedding = await this.openaiClient.generateEmbedding(embeddingInput);
      
      // Store in index
      this.embeddingsIndex.addEmbedding(filePath, embedding, content, summary);
      
    } catch (error) {
      console.error(chalk.red(`Failed to index ${filePath}:`, error));
    }
  }

  /**
   * Re-indexes a file if needed
   */
  private async reindexFile(filePath: string): Promise<void> {
    if (this.embeddingsIndex.needsReindex(filePath)) {
      await this.indexFile(filePath);
    }
  }

  /**
   * Generates a summary of a file for better search
   */
  private async generateFileSummary(filePath: string, content: string): Promise<string> {
    const truncatedContent = content.substring(0, 4000);
    const prompt = `${EMBEDDING_PROMPT}\n\nFile: ${path.basename(filePath)}\nContent:\n${truncatedContent}`;
    
    try {
      const summary = await this.openaiClient.complete(prompt);
      return summary.substring(0, 500); // Limit summary length
    } catch (error) {
      console.error('Failed to generate summary:', error);
      return '';
    }
  }
}

/**
 * Server manager for running in background
 */
export class ServerManager {
  private static instance?: CamilleServer;

  /**
   * Starts the server if not already running
   */
  public static async start(directory: string = process.cwd()): Promise<CamilleServer> {
    if (!this.instance) {
      this.instance = new CamilleServer();
      await this.instance.start(directory);
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
   * Stops the server if running
   */
  public static async stop(): Promise<void> {
    if (this.instance) {
      await this.instance.stop();
      this.instance = undefined;
    }
  }
}