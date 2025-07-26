/**
 * Supastate storage provider - sends data to server for processing
 */

import { logger } from '../logger.js';
import { ConfigManager } from '../config.js';
import { MemoryChunk, CodeFile, SearchResult } from './types.js';
import fetch from 'node-fetch';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class SupastateStorageProvider {
  private baseUrl: string;
  private apiKey: string;
  private config: ConfigManager;
  private pendingChunks: Map<string, MemoryChunk[]> = new Map();
  private pendingFiles: Map<string, CodeFile[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 100;
  private readonly FLUSH_INTERVAL = 1000; // 1 second

  constructor() {
    this.config = new ConfigManager();
    const supastate = this.config.getConfig().supastate;
    
    if (!supastate?.url || !supastate?.apiKey) {
      throw new Error('Supastate not configured');
    }
    
    this.baseUrl = supastate.url;
    this.apiKey = supastate.apiKey;
    
    // Start flush timer
    this.startFlushTimer();
  }

  /**
   * Extract Git metadata from a directory
   */
  private getGitMetadata(directory: string): any | null {
    try {
      // Check if directory is a git repository
      const gitDir = path.join(directory, '.git');
      if (!fs.existsSync(gitDir)) {
        return null;
      }

      // Get repository URL
      let repoUrl = '';
      try {
        repoUrl = execSync('git config --get remote.origin.url', {
          cwd: directory,
          encoding: 'utf8'
        }).trim();
      } catch (e) {
        // No remote configured
      }

      // Get current branch
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: directory,
        encoding: 'utf8'
      }).trim();

      // Get latest commit SHA
      const commitSha = execSync('git rev-parse HEAD', {
        cwd: directory,
        encoding: 'utf8'
      }).trim();

      // Get commit author info
      const authorInfo = execSync('git log -1 --format="%an|%ae"', {
        cwd: directory,
        encoding: 'utf8'
      }).trim().split('|');

      // Extract repo name from URL
      let repoName = '';
      if (repoUrl) {
        const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
        if (match) {
          repoName = match[1];
        }
      }

      return {
        repoUrl,
        repoName,
        branch,
        commitSha,
        author: authorInfo[0] || '',
        authorEmail: authorInfo[1] || ''
      };
    } catch (error) {
      logger.debug('Failed to extract git metadata:', error);
      return null;
    }
  }

  /**
   * Add memory chunk - batches and sends to server
   */
  async addMemory(sessionId: string, chunk: MemoryChunk): Promise<void> {
    // Add to pending batch
    if (!this.pendingChunks.has(sessionId)) {
      this.pendingChunks.set(sessionId, []);
    }
    
    this.pendingChunks.get(sessionId)!.push(chunk);
    
    // Flush if batch is large enough
    const chunks = this.pendingChunks.get(sessionId)!;
    if (chunks.length >= this.BATCH_SIZE) {
      await this.flushMemories(sessionId);
    }
  }

  /**
   * Add code file - batches and sends to server
   */
  async addCodeFile(projectPath: string, file: CodeFile): Promise<void> {
    if (!this.pendingFiles.has(projectPath)) {
      this.pendingFiles.set(projectPath, []);
    }
    
    this.pendingFiles.get(projectPath)!.push(file);
    
    // Flush if batch is large enough
    const files = this.pendingFiles.get(projectPath)!;
    if (files.length >= this.BATCH_SIZE) {
      await this.flushCodeFiles(projectPath);
    }
  }

  /**
   * Search memories using server-side embeddings
   */
  async searchMemories(query: string, limit: number = 20): Promise<SearchResult[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/search/memories?` + new URLSearchParams({
        q: query,
        limit: limit.toString(),
        includeProcessing: 'true'
      }), {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Log if items are still processing
      if (data.processingCount > 0) {
        logger.info(`Note: ${data.processingCount} memories still being processed`);
      }

      return data.results.map((r: any) => ({
        content: r.content,
        score: r.similarity,
        metadata: r.metadata,
        chunkId: r.chunkId,
      }));
    } catch (error) {
      logger.error('Memory search failed:', error);
      return [];
    }
  }

  /**
   * Flush pending memories to server
   */
  private async flushMemories(sessionId?: string): Promise<void> {
    const sessionsToFlush = sessionId 
      ? [sessionId] 
      : Array.from(this.pendingChunks.keys());

    for (const sid of sessionsToFlush) {
      const chunks = this.pendingChunks.get(sid);
      if (!chunks || chunks.length === 0) continue;

      try {
        logger.debug(`Flushing ${chunks.length} memory chunks for session ${sid}`);
        
        // Get project path from first chunk's metadata, fallback to cwd
        const projectPath = chunks[0]?.metadata?.projectPath || process.cwd();
        
        const response = await fetch(`${this.baseUrl}/api/ingest/memory`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: sid,
            projectPath: projectPath,
            chunks: chunks.map(c => ({
              chunkId: c.chunkId,
              content: c.content,
              metadata: c.metadata,
            })),
          }),
        });

        if (!response.ok) {
          throw new Error(`Ingestion failed: ${response.statusText}`);
        }

        const result = await response.json() as any;
        logger.info(`Queued ${result.queued} chunks for processing`);
        
        // Clear flushed chunks
        this.pendingChunks.delete(sid);
      } catch (error) {
        logger.error(`Failed to flush memories for session ${sid}:`, error);
      }
    }
  }

  /**
   * Flush pending code files to server
   */
  private async flushCodeFiles(projectPath?: string): Promise<void> {
    const projectsToFlush = projectPath 
      ? [projectPath] 
      : Array.from(this.pendingFiles.keys());

    for (const project of projectsToFlush) {
      const files = this.pendingFiles.get(project);
      if (!files || files.length === 0) continue;

      try {
        logger.debug(`Flushing ${files.length} code files for project ${project}`);
        
        // Extract git metadata once for the project
        const gitMetadata = this.getGitMetadata(project);
        
        // Get project name from path
        const projectName = path.basename(project);
        
        // Determine workspace ID (for now, use user workspace)
        // In a real implementation, this would come from auth context
        const workspaceId = 'user:' + (this.config.getConfig().userId || 'default');
        
        // Prepare files with git metadata
        const filesWithMetadata = files.map(f => ({
          path: path.relative(project, f.path), // Make path relative to project
          content: f.content,
          language: f.language,
          lastModified: f.lastModified,
          gitMetadata: gitMetadata
        }));
        
        const response = await fetch(`${this.baseUrl}/functions/v1/ingest-code`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: workspaceId,
            projectName: projectName,
            files: filesWithMetadata,
            fullSync: false
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Code ingestion failed: ${response.statusText} - ${errorText}`);
        }

        const result = await response.json() as any;
        logger.info(`Code ingestion task created: ${result.taskId}, queued ${result.filesQueued} files`);
        
        // Clear flushed files
        this.pendingFiles.delete(project);
      } catch (error) {
        logger.error(`Failed to flush code files for project ${project}:`, error);
      }
    }
  }

  /**
   * Start timer to flush pending data
   */
  private startFlushTimer(): void {
    this.flushInterval = setInterval(async () => {
      await this.flushAll();
    }, this.FLUSH_INTERVAL);
  }

  /**
   * Flush all pending data
   */
  async flushAll(): Promise<void> {
    await this.flushMemories();
    await this.flushCodeFiles();
  }

  /**
   * Cleanup
   */
  async close(): Promise<void> {
    // Flush any remaining data
    await this.flushAll();
    
    // Stop flush timer
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /**
   * Search code files
   */
  async searchCode(query: string, limit: number = 20): Promise<SearchResult[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/search/code?` + new URLSearchParams({
        q: query,
        limit: limit.toString(),
        includeProcessing: 'true'
      }), {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();
      return data.results || [];
    } catch (error) {
      logger.error('Failed to search code', error);
      return [];
    }
  }

  /**
   * Similarity search (not implemented - use search API)
   */
  async similaritySearch(
    query: string,
    options?: { limit?: number; threshold?: number }
  ): Promise<any[]> {
    // Similarity search happens server-side via API
    return [];
  }

  /**
   * Query graph (not implemented - will use graph API)
   */
  async queryGraph(
    query: string,
    options?: { includeRelationships?: boolean; depth?: number }
  ): Promise<any> {
    // Graph queries will be implemented server-side
    return { entities: [], relationships: [] };
  }
}