/**
 * @deprecated This client uses the old API key authentication method.
 * New code should use SupastateStorageProvider which uses JWT tokens and edge functions.
 * 
 * Supastate API client for communicating with Supastate cloud service
 */

import { ConfigManager } from '../config.js';
import { logger } from '../logger.js';
import chalk from 'chalk';

export interface MemoryChunk {
  chunkId: string;
  content: string;
  embedding: number[];
  metadata?: any;
}

export interface GraphNode {
  id: string;
  type: 'file' | 'function' | 'class' | 'module';
  name: string;
  path?: string;
  metadata?: any;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'imports' | 'calls' | 'extends' | 'implements';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata?: any;
}

export interface SyncStatus {
  lastSync?: Date;
  chunksCount?: number;
  status: 'idle' | 'syncing' | 'error';
  errorMessage?: string;
}

/**
 * @deprecated Use SupastateStorageProvider instead
 */
export class SupastateClient {
  private config: ConfigManager;
  private baseUrl: string;
  private apiKey: string;
  private teamId?: string;
  private userId?: string;

  constructor() {
    this.config = new ConfigManager();
    const supastate = this.config.getConfig().supastate;
    
    // Support both old API key and new JWT auth for backward compatibility
    if (!supastate?.url || (!supastate?.apiKey && !supastate?.accessToken)) {
      throw new Error('Supastate not configured. Run "camille supastate login" first.');
    }
    
    this.baseUrl = supastate.url;
    this.apiKey = supastate.apiKey || ''; // May be empty for JWT auth
    this.teamId = supastate.teamId;
    this.userId = supastate.userId;
    
    if (!this.apiKey && supastate.accessToken) {
      logger.warn('SupastateClient is using deprecated API key auth. Please use SupastateStorageProvider for JWT auth.');
    }
  }

  /**
   * Test connection to Supastate
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        headers: {
          'x-api-key': this.apiKey,
        },
      });
      
      return response.ok;
    } catch (error) {
      logger.error('Failed to connect to Supastate:', error);
      return false;
    }
  }

  /**
   * Sync memory chunks to Supastate
   */
  async syncMemories(projectName: string, chunks: MemoryChunk[]): Promise<{ success: boolean; synced?: number; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/memories/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId, // Optional for team workspaces
          projectName,
          chunks,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        return { success: false, error: error.error || 'Unknown error' };
      }

      const result = await response.json() as any;
      return { success: true, synced: result.synced };
    } catch (error: unknown) {
      logger.error('Memory sync failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Batch sync memory chunks to Supastate (optimized for large migrations)
   */
  async batchSyncMemories(
    projectName: string, 
    chunks: MemoryChunk[], 
    batchMetadata?: {
      totalBatches?: number;
      currentBatch?: number;
      syncSessionId?: string;
    }
  ): Promise<{ 
    success: boolean; 
    processed?: number; 
    failed?: number; 
    duration?: number;
    error?: string 
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/memories/batch-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId,
          projectName,
          chunks,
          batchMetadata,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        return { success: false, error: error.error || 'Unknown error' };
      }

      const result = await response.json() as any;
      return { 
        success: true, 
        processed: result.processed,
        failed: result.failed,
        duration: result.duration
      };
    } catch (error: unknown) {
      logger.error('Batch memory sync failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Search memories in Supastate
   */
  async searchMemories(query: string, embedding: number[], projectFilter?: string[], limit = 10): Promise<any[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/memories/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId,
          query,
          embedding,
          projectFilter,
          limit,
        }),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const result = await response.json() as any;
      return result.memories || [];
    } catch (error: unknown) {
      logger.error('Memory search failed:', error);
      return [];
    }
  }

  /**
   * Sync code graph to Supastate
   */
  async syncGraph(projectName: string, graphData: GraphData): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/graph/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId,
          projectName,
          graph: graphData,
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        return { success: false, error: error.error || 'Unknown error' };
      }

      return { success: true };
    } catch (error: unknown) {
      logger.error('Graph sync failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Query code graph from Supastate
   */
  async queryGraph(query: string, projectFilter?: string[]): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/api/graph/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId,
          query,
          projectFilter,
        }),
      });

      if (!response.ok) {
        throw new Error(`Graph query failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('Graph query failed:', error);
      return null;
    }
  }

  /**
   * Get sync status from Supastate
   */
  async getSyncStatus(projectName?: string): Promise<SyncStatus> {
    try {
      const params = new URLSearchParams();
      if (this.teamId) {
        params.append('teamId', this.teamId);
      }
      
      if (projectName) {
        params.append('projectName', projectName);
      }

      const response = await fetch(`${this.baseUrl}/api/sync/status?${params}`, {
        headers: {
          'x-api-key': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get sync status: ${response.statusText}`);
      }

      const result = await response.json() as any;
      return {
        lastSync: result.lastSync ? new Date(result.lastSync) : undefined,
        chunksCount: result.chunksCount,
        status: 'idle',
      };
    } catch (error: unknown) {
      logger.error('Failed to get sync status:', error);
      return {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a PR review request
   */
  async createReview(prUrl: string, reviewConfig?: any): Promise<{ success: boolean; reviewId?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/reviews/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          teamId: this.teamId,
          prUrl,
          reviewConfig: reviewConfig || { style: 'thorough' },
        }),
      });

      if (!response.ok) {
        const error = await response.json() as any;
        return { success: false, error: error.error || 'Unknown error' };
      }

      const result = await response.json() as any;
      return { success: true, reviewId: result.reviewId };
    } catch (error: unknown) {
      logger.error('Failed to create review:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}