/**
 * PreCompact hook implementation for capturing Claude Code transcripts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../logger.js';
import { ConfigManager } from '../../config.js';
import { TranscriptProcessor, Message, Chunk } from '../processors/transcript-processor.js';
import { TranscriptMessage } from '../types.js';
import * as crypto from 'crypto';
import fetch from 'node-fetch';

/**
 * Raw transcript entry from Claude Code
 */
interface RawTranscriptEntry {
  type: string;
  timestamp: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    type: string;
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  content?: string;
  role?: string;
  metadata?: any;
  [key: string]: any;
}

interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: 'PreCompact';
  trigger: string;
  custom_instructions?: string;
  project_path?: string;
  compaction_reason: 'size' | 'time' | 'manual';
}

interface ProcessingCheckpoint {
  transcript_path: string;
  session_id: string;
  last_processed_line: number;
  last_processed_timestamp: string;
  content_hash: string;
}

/**
 * Hook that runs before Claude Code compacts conversation history
 */
export class PreCompactHook {
  private configManager: ConfigManager;
  private transcriptProcessor: TranscriptProcessor;
  private checkpointsPath: string;
  private checkpoints: Map<string, ProcessingCheckpoint> = new Map();

  constructor() {
    this.configManager = new ConfigManager();
    this.transcriptProcessor = new TranscriptProcessor();
    this.checkpointsPath = path.join(os.homedir(), '.camille', 'memory', 'checkpoints.json');
  }

  /**
   * Main entry point for the hook
   */
  async run(input: PreCompactInput): Promise<void> {
    try {
      logger.info('PreCompact hook triggered', {
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        reason: input.compaction_reason
      });

      // Check if memory is enabled
      const config = this.configManager.getConfig();
      if (!config.memory?.enabled || !config.memory?.transcript?.enabled) {
        logger.info('Memory system disabled, skipping transcript processing');
        return;
      }
      
      // Check if Supastate is configured for direct ingestion
      const useSupastateDirect = config.supastate?.enabled && config.supastate?.url && config.supastate?.accessToken;
      if (useSupastateDirect) {
        logger.info('Using direct Supastate ingestion for pre-compact hook');
      }

      // Load checkpoints
      await this.loadCheckpoints();

      // Process the transcript
      const stats = await this.processTranscript(input);

      // Save checkpoints
      await this.saveCheckpoints();

      // Log success
      logger.info('Transcript processed successfully', stats);
      
      // Output success message for Claude Code
      console.log(JSON.stringify({
        status: 'success',
        message: 'Transcript indexed successfully',
        stats
      }));

    } catch (error) {
      logger.error('PreCompact hook failed', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error,
        input 
      });
      
      // Exit with code 2 to indicate failure (blocking)
      console.error('Failed to process transcript: ' + (error instanceof Error ? error.message : String(error)));
      process.exit(2);
    }
  }

  /**
   * Process the transcript file
   */
  private async processTranscript(input: PreCompactInput): Promise<any> {
    // Read the transcript
    const messages = await this.readTranscript(input.transcript_path);
    
    if (messages.length === 0) {
      return {
        messages_processed: 0,
        chunks_created: 0,
        embeddings_generated: 0,
        processing_time_ms: 0
      };
    }

    // Get new messages since last checkpoint
    const newMessages = await this.getNewMessages(messages, input.session_id);
    
    if (newMessages.length === 0) {
      logger.info('No new messages to process');
      return {
        messages_processed: 0,
        chunks_created: 0,
        embeddings_generated: 0,
        processing_time_ms: 0
      };
    }

    const startTime = Date.now();

    // Convert to processor format
    const processorMessages: Message[] = newMessages.map((msg: any) => {
      // Extract text content from Claude's message format
      let content = '';
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        // Claude's format has content as an array of content blocks
        content = msg.message.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
      } else if (typeof msg.content === 'string') {
        // Fallback for simple string content
        content = msg.content;
      } else if (typeof msg.message === 'string') {
        // Another possible format
        content = msg.message;
      }
      
      return {
        timestamp: msg.timestamp,
        role: (msg.type || msg.role) as 'human' | 'assistant' | 'system',
        content: content,
        metadata: {
          ...msg.metadata,
          sessionId: msg.sessionId,
          uuid: msg.uuid,
          parentUuid: msg.parentUuid,
          model: msg.message?.model
        }
      };
    }).filter(msg => msg.content);

    // Determine project path - use input.project_path if provided, otherwise extract from messages
    let projectPath = input.project_path;
    
    if (!projectPath) {
      // Try to find project path from the raw messages
      for (const msg of newMessages) {
        if (msg.cwd) {
          projectPath = msg.cwd;
          logger.info('Found project path from message cwd', { projectPath });
          break;
        }
      }
      
      if (!projectPath) {
        logger.warn('No project path found in hook input or transcript messages');
        // We'll skip processing if we can't determine the project
        return {
          messages_processed: 0,
          chunks_created: 0,
          embeddings_generated: 0,
          processing_time_ms: 0,
          error: 'No project path could be determined'
        };
      }
    }
    
    // Check if we should use direct Supastate ingestion
    const config = this.configManager.getConfig();
    const useSupastateDirect = config.supastate?.enabled && config.supastate?.url && config.supastate?.accessToken;
    
    if (useSupastateDirect) {
      // Direct ingestion to Supastate
      return await this.ingestToSupastateDirect(processorMessages, input.session_id, projectPath);
    }
    
    // Use TranscriptProcessor for chunking, embedding, and storage
    const result = await this.transcriptProcessor.processMessages(
      processorMessages,
      input.session_id,
      projectPath,
      {
        chunkSize: this.configManager.getConfig().memory?.indexing?.chunkSize || 4000,
        chunkOverlap: this.configManager.getConfig().memory?.indexing?.chunkOverlap || 200,
        embeddingModel: this.configManager.getConfig().memory?.indexing?.embeddingModel || 'text-embedding-3-large'
      }
    );

    // Update checkpoint
    const lastMessage = newMessages[newMessages.length - 1];
    await this.updateCheckpoint(input.session_id, lastMessage, messages.length - 1);

    return {
      messages_processed: newMessages.length,
      chunks_created: result.chunks,
      embeddings_generated: result.embeddings,
      processing_time_ms: Date.now() - startTime
    };
  }

  /**
   * Read and parse JSONL transcript
   */
  private async readTranscript(transcriptPath: string): Promise<RawTranscriptEntry[]> {
    try {
      const content = await fs.readFile(transcriptPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      const messages = lines.map((line, index) => {
        try {
          const parsed = JSON.parse(line);
          // Only include actual message entries, skip summaries and other types
          if (parsed.type === 'assistant' || parsed.type === 'human' || parsed.type === 'user') {
            return parsed;
          }
          return null;
        } catch (e) {
          logger.warn('Failed to parse transcript line', { line, index, error: e });
          return null;
        }
      }).filter(Boolean) as RawTranscriptEntry[];
      
      logger.debug('Read transcript', { 
        path: transcriptPath, 
        totalLines: lines.length, 
        messageCount: messages.length 
      });
      
      return messages;
    } catch (error) {
      logger.error('Failed to read transcript', { transcriptPath, error });
      throw error;
    }
  }

  /**
   * Get only new messages since last checkpoint
   */
  private async getNewMessages(
    transcript: RawTranscriptEntry[], 
    sessionId: string
  ): Promise<RawTranscriptEntry[]> {
    const checkpoint = this.checkpoints.get(sessionId);
    
    if (!checkpoint) {
      // First time processing this session
      return transcript;
    }
    
    // Find where we left off
    const lastIndex = checkpoint.last_processed_line;
    
    // Verify the checkpoint is still valid
    if (lastIndex < transcript.length) {
      const checkMessage = transcript[lastIndex];
      const currentHash = this.hashContent(checkMessage.content || '');
      
      if (currentHash !== checkpoint.content_hash) {
        // Transcript might have been edited, reprocess all
        logger.warn('Checkpoint hash mismatch, reprocessing entire transcript');
        return transcript;
      }
    } else {
      // Transcript might have been edited, reprocess all
      logger.warn('Checkpoint not found, reprocessing entire transcript');
      return transcript;
    }
    
    // Return only new messages
    return transcript.slice(lastIndex + 1);
  }

  /**
   * Update processing checkpoint
   */
  private async updateCheckpoint(
    sessionId: string, 
    lastMessage: RawTranscriptEntry, 
    lineNumber: number
  ): Promise<void> {
    this.checkpoints.set(sessionId, {
      session_id: sessionId,
      transcript_path: '', // Will be updated on next run
      last_processed_line: lineNumber,
      last_processed_timestamp: lastMessage.timestamp,
      content_hash: this.hashContent(lastMessage.content || '')
    });
  }

  /**
   * Hash content for checkpoint verification
   */
  private hashContent(content: string): string {
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Load checkpoints from disk
   */
  private async loadCheckpoints(): Promise<void> {
    try {
      const data = await fs.readFile(this.checkpointsPath, 'utf8');
      const checkpoints = JSON.parse(data);
      
      for (const checkpoint of checkpoints) {
        this.checkpoints.set(checkpoint.session_id, checkpoint);
      }
    } catch (error) {
      // File doesn't exist yet, that's ok
      if ((error as any).code !== 'ENOENT') {
        logger.error('Failed to load checkpoints', { error });
      }
    }
  }

  /**
   * Save checkpoints to disk
   */
  private async saveCheckpoints(): Promise<void> {
    try {
      const checkpointArray = Array.from(this.checkpoints.values());
      const dir = path.dirname(this.checkpointsPath);
      
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });
      
      // Write checkpoint file
      await fs.writeFile(
        this.checkpointsPath, 
        JSON.stringify(checkpointArray, null, 2)
      );
    } catch (error) {
      logger.error('Failed to save checkpoints', { error });
      throw error;
    }
  }
  
  /**
   * Ingest messages directly to Supastate
   */
  private async ingestToSupastateDirect(
    messages: Message[],
    sessionId: string,
    projectPath: string
  ): Promise<any> {
    const startTime = Date.now();
    const config = this.configManager.getConfig();
    const supastate = config.supastate!;
    
    // Create chunks similar to how TranscriptProcessor does it
    const chunkSize = config.memory?.indexing?.chunkSize || 4000;
    const chunkOverlap = config.memory?.indexing?.chunkOverlap || 200;
    
    const chunks = [];
    let currentChunk: Message[] = [];
    let currentSize = 0;
    
    for (const message of messages) {
      const messageSize = message.content.length;
      
      if (currentSize + messageSize > chunkSize && currentChunk.length > 0) {
        // Create chunk
        chunks.push(this.createChunkFromMessages(currentChunk, sessionId, projectPath));
        
        // Start new chunk with overlap
        const overlapMessages = [];
        let overlapSize = 0;
        for (let i = currentChunk.length - 1; i >= 0; i--) {
          overlapSize += currentChunk[i].content.length;
          if (overlapSize > chunkOverlap) break;
          overlapMessages.unshift(currentChunk[i]);
        }
        currentChunk = [...overlapMessages, message];
        currentSize = overlapSize + messageSize;
      } else {
        currentChunk.push(message);
        currentSize += messageSize;
      }
    }
    
    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(this.createChunkFromMessages(currentChunk, sessionId, projectPath));
    }
    
    // Prepare chunks for Supastate format
    const supastateChunks = chunks.map((chunk, index) => ({
      sessionId: sessionId,
      chunkId: crypto.randomUUID(),
      content: chunk.text,
      metadata: {
        ...chunk.metadata,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        messageCount: chunk.messageCount,
        hasCode: false,
        projectPath: projectPath,
        chunkIndex: index,
        source: 'precompact-hook'
      }
    }));
    
    try {
      // Get access token (may need to refresh)
      let accessToken = supastate.accessToken;
      
      // Check if token might be expired
      const now = Math.floor(Date.now() / 1000);
      if (supastate.expiresAt && now >= supastate.expiresAt - 60) {
        // Try to refresh token
        logger.debug('Access token expired or expiring soon, attempting refresh...');
        
        const supabaseUrl = supastate.supabaseUrl || (supastate.url || '').replace('https://service.supastate.ai', 'https://zqlfxakbkwssxfynrmnk.supabase.co');
        const refreshResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supastate.supabaseAnonKey || '',
          },
          body: JSON.stringify({
            refresh_token: supastate.refreshToken,
          }),
        });
        
        if (refreshResponse.ok) {
          const data = await refreshResponse.json() as any;
          accessToken = data.access_token;
          
          // Update config with new tokens
          this.configManager.updateConfig({
            supastate: {
              ...supastate,
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
            },
          });
        } else {
          logger.warn('Failed to refresh token, using existing token');
        }
      }
      
      // Send to Supastate ingest-memory endpoint
      const response = await fetch(`${supastate.url || 'https://service.supastate.ai'}/functions/v1/ingest-memory`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectName: path.basename(projectPath),
          chunks: supastateChunks,
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Supastate ingestion failed: ${response.statusText} - ${errorText}`);
      }
      
      const result = await response.json() as any;
      
      logger.info('Successfully ingested to Supastate', {
        chunksProcessed: result.processed || chunks.length,
        processingTimeMs: Date.now() - startTime
      });
      
      return {
        messages_processed: messages.length,
        chunks_created: chunks.length,
        embeddings_generated: chunks.length,
        processing_time_ms: Date.now() - startTime,
        supastate_ingestion: true
      };
    } catch (error) {
      logger.error('Direct Supastate ingestion failed', { error });
      throw error;
    }
  }
  
  /**
   * Create a chunk object from messages
   */
  private createChunkFromMessages(
    messages: Message[],
    sessionId: string,
    projectPath: string
  ): Chunk {
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    
    return {
      id: crypto.randomUUID(),
      messages,
      text,
      startTime: messages[0].timestamp,
      endTime: messages[messages.length - 1].timestamp,
      messageCount: messages.length,
      tokenCount: Math.ceil(text.length / 4), // Rough estimate
      metadata: {
        sessionId,
        projectPath,
      }
    };
  }
}