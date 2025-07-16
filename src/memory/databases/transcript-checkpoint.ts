import fs from 'fs';
import path from 'path';
import { logger } from '../../logger.js';

interface TranscriptCheckpoint {
  path: string;
  lastModified: number;
  size: number;
  indexed: boolean;
  indexedAt: number;
  chunks: number;
}

export class TranscriptCheckpointManager {
  private checkpointPath: string;
  private checkpoints: Map<string, TranscriptCheckpoint> = new Map();

  constructor(memoryDir: string) {
    this.checkpointPath = path.join(memoryDir, 'transcript-checkpoints.json');
    this.loadCheckpoints();
  }

  /**
   * Load checkpoints from disk
   */
  private loadCheckpoints(): void {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        const data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
        this.checkpoints = new Map(Object.entries(data));
        logger.info(`Loaded ${this.checkpoints.size} transcript checkpoints`);
      }
    } catch (error) {
      logger.error('Failed to load transcript checkpoints', error as Error);
    }
  }

  /**
   * Save checkpoints to disk
   */
  private saveCheckpoints(): void {
    try {
      const data = Object.fromEntries(this.checkpoints);
      fs.writeFileSync(this.checkpointPath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to save transcript checkpoints', error as Error);
    }
  }

  /**
   * Check if a transcript needs indexing
   */
  needsIndexing(transcriptPath: string): boolean {
    try {
      const stats = fs.statSync(transcriptPath);
      const checkpoint = this.checkpoints.get(transcriptPath);

      if (!checkpoint) {
        // Never indexed before
        return true;
      }

      // Check if file has been modified since last index
      if (stats.mtimeMs > checkpoint.lastModified) {
        logger.info('Transcript modified since last index', {
          path: transcriptPath,
          lastModified: new Date(checkpoint.lastModified),
          currentModified: new Date(stats.mtimeMs)
        });
        return true;
      }

      // Check if file size changed
      if (stats.size !== checkpoint.size) {
        logger.info('Transcript size changed since last index', {
          path: transcriptPath,
          lastSize: checkpoint.size,
          currentSize: stats.size
        });
        return true;
      }

      // Already indexed and unchanged
      return false;
    } catch (error) {
      logger.error('Error checking transcript', { transcriptPath, error });
      return true; // Index on error
    }
  }

  /**
   * Mark a transcript as indexed
   */
  markIndexed(transcriptPath: string, chunks: number): void {
    try {
      const stats = fs.statSync(transcriptPath);
      
      this.checkpoints.set(transcriptPath, {
        path: transcriptPath,
        lastModified: stats.mtimeMs,
        size: stats.size,
        indexed: true,
        indexedAt: Date.now(),
        chunks
      });

      this.saveCheckpoints();
      
      logger.info('Marked transcript as indexed', {
        path: transcriptPath,
        chunks,
        size: stats.size
      });
    } catch (error) {
      logger.error('Failed to mark transcript as indexed', { transcriptPath, error });
    }
  }

  /**
   * Get checkpoint for a transcript
   */
  getCheckpoint(transcriptPath: string): TranscriptCheckpoint | undefined {
    return this.checkpoints.get(transcriptPath);
  }

  /**
   * Get all checkpoints
   */
  getAllCheckpoints(): Map<string, TranscriptCheckpoint> {
    return new Map(this.checkpoints);
  }

  /**
   * Clear all checkpoints (for testing or reset)
   */
  clearCheckpoints(): void {
    this.checkpoints.clear();
    this.saveCheckpoints();
  }

  /**
   * Get statistics about indexed transcripts
   */
  getStats(): {
    total: number;
    indexed: number;
    totalChunks: number;
    lastIndexed?: Date;
  } {
    const indexed = Array.from(this.checkpoints.values()).filter(c => c.indexed);
    const totalChunks = indexed.reduce((sum, c) => sum + c.chunks, 0);
    const lastIndexed = indexed.reduce((latest, c) => {
      return c.indexedAt > (latest || 0) ? c.indexedAt : latest;
    }, 0);

    return {
      total: this.checkpoints.size,
      indexed: indexed.length,
      totalChunks,
      lastIndexed: lastIndexed ? new Date(lastIndexed) : undefined
    };
  }
}