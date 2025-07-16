/**
 * Transcript processing pipeline for converting conversation transcripts
 * into searchable, embedded chunks
 */

import { logger } from '../../logger.js';
import { ConfigManager } from '../../config.js';
import { OpenAIClient } from '../../openai-client.js';
import { VectorDB } from '../databases/vector-db.js';
import { LanceVectorDB } from '../databases/lance-db.js';

export interface Message {
  timestamp: string;
  role: 'human' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, any>;
}

export interface Chunk {
  id: string;
  messages: Message[];
  text: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  tokenCount: number;
  metadata: {
    sessionId?: string;
    projectPath?: string;
    topics?: string[];
    chunkIndex?: number;
  };
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface ProcessingOptions {
  chunkSize?: number;        // Target characters per chunk
  chunkOverlap?: number;     // Overlap between chunks
  maxChunkMessages?: number; // Max messages per chunk
  embeddingModel?: string;   // OpenAI embedding model
}

export class TranscriptProcessor {
  private vectorDB: VectorDB;
  private openAI: OpenAIClient;
  private config: ConfigManager;
  private defaultOptions: ProcessingOptions = {
    chunkSize: 2000,          // ~500 tokens (more conservative to avoid hitting limits)
    chunkOverlap: 100,        // ~25 tokens overlap
    maxChunkMessages: 10,     // Max 10 messages per chunk (reduced from 20)
    embeddingModel: 'text-embedding-3-large'
  };

  constructor() {
    this.config = new ConfigManager();
    const apiKey = this.config.getOpenAIApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }
    this.openAI = new OpenAIClient(apiKey, this.config.getConfig(), process.cwd());
    this.vectorDB = new LanceVectorDB('transcripts');
  }

  /**
   * Process messages directly (for incremental processing)
   */
  async processMessages(
    messages: Message[],
    sessionId: string,
    projectPath?: string,
    options?: ProcessingOptions
  ): Promise<{ chunks: number; embeddings: number }> {
    const opts = { ...this.defaultOptions, ...options };
    
    try {
      if (messages.length === 0) {
        return { chunks: 0, embeddings: 0 };
      }

      // Create semantic chunks
      const chunks = this.createChunks(messages, sessionId, projectPath, opts);
      
      // Generate embeddings
      const embeddedChunks = await this.generateEmbeddings(chunks, opts);
      
      // Store in vector database
      await this.store(embeddedChunks);
      
      return {
        chunks: chunks.length,
        embeddings: embeddedChunks.length
      };
    } catch (error) {
      logger.error('Failed to process messages', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error,
        messageCount: messages.length,
        sessionId,
        projectPath
      });
      throw error;
    }
  }

  /**
   * Process a transcript file and store embeddings
   */
  async processTranscript(
    transcriptPath: string,
    sessionId: string,
    projectPath?: string,
    options?: ProcessingOptions
  ): Promise<{ chunks: number; embeddings: number }> {
    const opts = { ...this.defaultOptions, ...options };
    
    try {
      // Extract messages from transcript
      const messages = await this.extractMessages(transcriptPath);
      
      if (messages.length === 0) {
        return { chunks: 0, embeddings: 0 };
      }

      // Create semantic chunks
      const chunks = this.createChunks(messages, sessionId, projectPath, opts);
      
      // Generate embeddings
      const embeddedChunks = await this.generateEmbeddings(chunks, opts);
      
      // Store in vector database
      await this.store(embeddedChunks);
      
      return {
        chunks: chunks.length,
        embeddings: embeddedChunks.length
      };
    } catch (error) {
      logger.error('Failed to process transcript', { error, transcriptPath });
      throw error;
    }
  }

  /**
   * Extract messages from JSONL transcript
   */
  async extractMessages(transcriptPath: string): Promise<Message[]> {
    const fs = await import('fs/promises');
    const messages: Message[] = [];
    
    try {
      const content = await fs.readFile(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          // Handle both direct and nested message structures
          const message = data.message || data;
          if (message.role && message.content) {
            // Extract text content - handle both string and array formats
            let textContent: string;
            if (typeof message.content === 'string') {
              textContent = message.content;
            } else if (Array.isArray(message.content)) {
              // Claude format: content is array of {type, text} objects
              textContent = message.content
                .filter((c: any) => c.type === 'text' && c.text)
                .map((c: any) => c.text)
                .join('\n');
            } else {
              textContent = JSON.stringify(message.content);
            }
            
            // Only add if there's actual content
            if (textContent && textContent.trim()) {
              messages.push({
                timestamp: data.timestamp || new Date().toISOString(),
                role: message.role,
                content: textContent,
                metadata: data.metadata || {}
              });
            }
          }
        } catch (parseError) {
          logger.debug('Skipping malformed line', { line, error: parseError });
        }
      }
      
      return messages;
    } catch (error) {
      logger.error('Failed to extract messages', { error, transcriptPath });
      throw error;
    }
  }

  /**
   * Create semantic chunks from messages
   */
  createChunks(
    messages: Message[],
    sessionId: string,
    projectPath: string | undefined,
    options: ProcessingOptions
  ): Chunk[] {
    const chunks: Chunk[] = [];
    let currentChunk: Message[] = [];
    let currentLength = 0;
    
    // First, split any messages that are too large
    const processedMessages: Message[] = [];
    for (const message of messages) {
      if (message.content.length > options.chunkSize!) {
        // Split large message into smaller parts
        const parts = this.splitLargeMessage(message, options.chunkSize!);
        processedMessages.push(...parts);
      } else {
        processedMessages.push(message);
      }
    }
    
    for (let i = 0; i < processedMessages.length; i++) {
      const message = processedMessages[i];
      const messageLength = message.content ? message.content.length : 0;
      
      // Check if we should start a new chunk
      const shouldSplit = 
        currentLength + messageLength > options.chunkSize! ||
        currentChunk.length >= options.maxChunkMessages! ||
        this.isTopicBoundary(message, processedMessages[i - 1]) ||
        this.hasTimeGap(message, processedMessages[i - 1]);
      
      if (shouldSplit && currentChunk.length > 0) {
        // Create chunk from current messages
        chunks.push(this.createChunkFromMessages(
          currentChunk,
          sessionId,
          projectPath,
          chunks.length
        ));
        
        // Start new chunk with overlap
        const overlapMessages = this.getOverlapMessages(currentChunk, options.chunkOverlap!);
        currentChunk = [...overlapMessages, message];
        currentLength = currentChunk.reduce((sum, m) => sum + m.content.length, 0);
      } else {
        currentChunk.push(message);
        currentLength += messageLength;
      }
    }
    
    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(this.createChunkFromMessages(
        currentChunk,
        sessionId,
        projectPath,
        chunks.length
      ));
    }
    
    return chunks;
  }

  /**
   * Split a large message into smaller parts
   */
  private splitLargeMessage(message: Message, maxSize: number): Message[] {
    const parts: Message[] = [];
    const content = message.content;
    
    // Leave some room for safety - use 80% of max size to be extra conservative
    const safeSize = Math.floor(maxSize * 0.8);
    
    // Split by paragraphs first, then by sentences if needed
    const paragraphs = content.split('\n\n');
    let currentPart = '';
    
    for (const paragraph of paragraphs) {
      if (paragraph.length > safeSize) {
        // Split by sentences if paragraph is too large
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        
        for (const sentence of sentences) {
          if (currentPart.length + sentence.length > safeSize && currentPart.length > 0) {
            parts.push({
              ...message,
              content: currentPart.trim()
            });
            currentPart = sentence;
          } else if (sentence.length > safeSize) {
            // If a single sentence is too long, split by words
            if (currentPart.length > 0) {
              parts.push({
                ...message,
                content: currentPart.trim()
              });
              currentPart = '';
            }
            
            const words = sentence.split(' ');
            for (const word of words) {
              if (currentPart.length + word.length + 1 > safeSize && currentPart.length > 0) {
                parts.push({
                  ...message,
                  content: currentPart.trim()
                });
                currentPart = word;
              } else {
                currentPart += (currentPart.length > 0 ? ' ' : '') + word;
              }
            }
          } else {
            currentPart += sentence;
          }
        }
      } else if (currentPart.length + paragraph.length + 2 > safeSize && currentPart.length > 0) {
        parts.push({
          ...message,
          content: currentPart.trim()
        });
        currentPart = paragraph;
      } else {
        currentPart += (currentPart.length > 0 ? '\n\n' : '') + paragraph;
      }
    }
    
    // Don't forget the last part
    if (currentPart.length > 0) {
      parts.push({
        ...message,
        content: currentPart.trim()
      });
    }
    
    logger.info(`Split large message into ${parts.length} parts`, {
      originalLength: content.length,
      maxSize,
      partLengths: parts.map(p => p.content.length)
    });
    
    return parts;
  }

  /**
   * Generate embeddings for chunks
   */
  async generateEmbeddings(
    chunks: Chunk[],
    options: ProcessingOptions
  ): Promise<EmbeddedChunk[]> {
    const embeddedChunks: EmbeddedChunk[] = [];
    const batchSize = 20; // Process 20 chunks at a time
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      try {
        // Generate embeddings for batch
        const embeddings = await Promise.all(
          batch.map(chunk => 
            this.openAI.generateEmbedding(chunk.text)
          )
        );
        
        // Combine chunks with embeddings
        for (let j = 0; j < batch.length; j++) {
          embeddedChunks.push({
            ...batch[j],
            embedding: embeddings[j]
          });
        }
        
        logger.debug(`Generated embeddings for chunks ${i}-${i + batch.length}`);
      } catch (error) {
        logger.error('Failed to generate embeddings for batch', { error, batchIndex: i });
        throw error;
      }
    }
    
    return embeddedChunks;
  }

  /**
   * Store embedded chunks in vector database
   */
  async store(embeddedChunks: EmbeddedChunk[]): Promise<void> {
    await this.vectorDB.connect();
    
    try {
      for (const chunk of embeddedChunks) {
        await this.vectorDB.index(chunk.embedding, {
          content: chunk.text,
          chunkId: chunk.id,
          sessionId: chunk.metadata.sessionId,
          projectPath: chunk.metadata.projectPath,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          messageCount: chunk.messageCount,
          topics: chunk.metadata.topics,
          chunkIndex: chunk.metadata.chunkIndex
        });
      }
      
      logger.info(`Stored ${embeddedChunks.length} embedded chunks`);
    } finally {
      await this.vectorDB.close();
    }
  }

  /**
   * Check if this message represents a topic boundary
   */
  private isTopicBoundary(current: Message, previous?: Message): boolean {
    if (!previous || !current) return false;
    
    // Topic change indicators
    const topicMarkers = [
      'let\'s talk about',
      'moving on to',
      'next topic',
      'different question',
      'changing the subject',
      'on another note',
      'by the way',
      'btw'
    ];
    
    const content = current.content.toLowerCase();
    return topicMarkers.some(marker => content.includes(marker));
  }

  /**
   * Check if there's a significant time gap
   */
  private hasTimeGap(current: Message, previous?: Message): boolean {
    if (!previous || !current.timestamp || !previous.timestamp) return false;
    
    const gap = new Date(current.timestamp).getTime() - 
                new Date(previous.timestamp).getTime();
    
    // More than 5 minutes gap
    return gap > 5 * 60 * 1000;
  }

  /**
   * Get messages for overlap
   */
  private getOverlapMessages(messages: Message[], overlapSize: number): Message[] {
    const overlapMessages: Message[] = [];
    let currentSize = 0;
    
    // Add messages from end until we reach overlap size
    for (let i = messages.length - 1; i >= 0; i--) {
      const messageSize = messages[i].content.length;
      if (currentSize + messageSize > overlapSize) break;
      
      overlapMessages.unshift(messages[i]);
      currentSize += messageSize;
    }
    
    return overlapMessages;
  }

  /**
   * Create a chunk object from messages
   */
  private createChunkFromMessages(
    messages: Message[],
    sessionId: string,
    projectPath: string | undefined,
    index: number
  ): Chunk {
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const topics = this.extractTopics(messages);
    
    return {
      id: `${sessionId}-chunk-${index}`,
      messages,
      text,
      startTime: messages[0].timestamp,
      endTime: messages[messages.length - 1].timestamp,
      messageCount: messages.length,
      tokenCount: Math.ceil(text.length / 4), // Rough estimate
      metadata: {
        sessionId,
        projectPath,
        topics,
        chunkIndex: index
      }
    };
  }

  /**
   * Extract potential topics from messages
   */
  private extractTopics(messages: Message[]): string[] {
    const topics = new Set<string>();
    
    // Simple topic extraction based on keywords
    const topicPatterns = [
      /(?:about|regarding|concerning)\s+(\w+(?:\s+\w+)?)/gi,
      /(?:implement|create|build|fix|debug|refactor)\s+(\w+(?:\s+\w+)?)/gi,
      /(?:error|bug|issue|problem)\s+(?:with\s+)?(\w+(?:\s+\w+)?)/gi
    ];
    
    for (const message of messages) {
      for (const pattern of topicPatterns) {
        const matches = message.content.matchAll(pattern);
        for (const match of matches) {
          if (match[1]) {
            topics.add(match[1].toLowerCase());
          }
        }
      }
    }
    
    return Array.from(topics).slice(0, 5); // Limit to 5 topics
  }
}