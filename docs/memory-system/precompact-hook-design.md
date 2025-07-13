# PreCompact Hook Design Document

## Overview

The PreCompact hook captures Claude Code conversation transcripts before they are compacted, enabling Camille to build a searchable memory of all interactions across projects and sessions.

## Hook Architecture

### Registration

The PreCompact hook is registered in Claude Code's settings:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "camille memory-hook"
          }
        ]
      }
    ]
  }
}
```

### Input Format

```typescript
interface PreCompactInput {
  session_id: string;              // Unique session identifier
  transcript_path: string;         // Path to JSONL transcript file
  hook_event_name: "PreCompact";   // Event type
  trigger: string;                 // Compaction trigger reason
  custom_instructions?: string;    // User instructions if any
  project_path?: string;          // Current project directory
  compaction_reason: 'size' | 'time' | 'manual';
}
```

## Transcript Processing Pipeline

### 1. Transcript Reading and Parsing

```typescript
interface TranscriptMessage {
  timestamp: string;
  role: 'human' | 'assistant' | 'system';
  content: string;
  tool_uses?: ToolUse[];
  metadata?: {
    model?: string;
    token_count?: number;
    [key: string]: any;
  };
}

class TranscriptReader {
  async readTranscript(path: string): Promise<TranscriptMessage[]> {
    const content = await fs.readFile(path, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        logger.warn('Failed to parse transcript line', { line, error: e });
        return null;
      }
    }).filter(Boolean);
  }
}
```

### 2. Incremental Processing

To avoid re-processing already indexed content:

```typescript
interface ProcessingCheckpoint {
  transcript_path: string;
  session_id: string;
  last_processed_line: number;
  last_processed_timestamp: string;
  content_hash: string;  // Hash of last processed content
}

class IncrementalProcessor {
  private checkpoints: Map<string, ProcessingCheckpoint>;
  
  async getNewMessages(
    transcript: TranscriptMessage[], 
    sessionId: string
  ): Promise<TranscriptMessage[]> {
    const checkpoint = this.checkpoints.get(sessionId);
    
    if (!checkpoint) {
      // First time processing this session
      return transcript;
    }
    
    // Find where we left off
    const lastIndex = transcript.findIndex(msg => 
      msg.timestamp === checkpoint.last_processed_timestamp
    );
    
    if (lastIndex === -1) {
      // Transcript might have been edited, reprocess all
      logger.warn('Checkpoint not found, reprocessing entire transcript');
      return transcript;
    }
    
    // Return only new messages
    return transcript.slice(lastIndex + 1);
  }
  
  async saveCheckpoint(
    sessionId: string, 
    lastMessage: TranscriptMessage, 
    lineNumber: number
  ): Promise<void> {
    this.checkpoints.set(sessionId, {
      session_id: sessionId,
      last_processed_line: lineNumber,
      last_processed_timestamp: lastMessage.timestamp,
      content_hash: this.hashContent(lastMessage.content)
    });
    
    // Persist to disk
    await this.persistCheckpoints();
  }
}
```

### 3. Semantic Chunking Strategy

```typescript
interface SemanticChunk {
  id: string;
  session_id: string;
  project_path: string;
  messages: TranscriptMessage[];
  start_timestamp: string;
  end_timestamp: string;
  summary?: string;
  topics?: string[];
}

class SemanticChunker {
  private readonly MAX_CHUNK_SIZE = 2000;  // tokens
  private readonly MIN_CHUNK_SIZE = 500;   // tokens
  
  async createChunks(messages: TranscriptMessage[]): Promise<SemanticChunk[]> {
    const chunks: SemanticChunk[] = [];
    let currentChunk: TranscriptMessage[] = [];
    let currentTokens = 0;
    
    for (const message of messages) {
      const messageTokens = this.estimateTokens(message.content);
      
      // Check if adding this message would exceed limits
      if (currentTokens + messageTokens > this.MAX_CHUNK_SIZE && 
          currentTokens >= this.MIN_CHUNK_SIZE) {
        // Save current chunk
        chunks.push(await this.finalizeChunk(currentChunk));
        currentChunk = [message];
        currentTokens = messageTokens;
      } else {
        currentChunk.push(message);
        currentTokens += messageTokens;
      }
      
      // Check for natural breakpoints (topic changes)
      if (this.isTopicBoundary(currentChunk, message)) {
        chunks.push(await this.finalizeChunk(currentChunk));
        currentChunk = [];
        currentTokens = 0;
      }
    }
    
    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(await this.finalizeChunk(currentChunk));
    }
    
    return chunks;
  }
  
  private isTopicBoundary(chunk: TranscriptMessage[], newMessage: TranscriptMessage): boolean {
    // Detect topic changes based on:
    // 1. Long time gaps (>5 minutes)
    // 2. New file/project context
    // 3. Explicit topic markers ("let's work on", "now let's", etc.)
    // 4. Tool usage patterns changing
    
    if (chunk.length === 0) return false;
    
    const lastMessage = chunk[chunk.length - 1];
    const timeDiff = new Date(newMessage.timestamp).getTime() - 
                     new Date(lastMessage.timestamp).getTime();
    
    // 5 minute gap suggests topic change
    if (timeDiff > 5 * 60 * 1000) return true;
    
    // Check for topic change markers
    const topicMarkers = [
      /now let's/i,
      /let's move on/i,
      /next,? (I'd like|let's|can we)/i,
      /switching to/i,
      /different topic/i
    ];
    
    return topicMarkers.some(marker => 
      newMessage.content.match(marker)
    );
  }
}
```

### 4. Embedding Generation

```typescript
class EmbeddingGenerator {
  private openaiClient: OpenAIClient;
  private embeddingCache: Map<string, number[]>;
  
  async generateEmbeddings(chunks: SemanticChunk[]): Promise<EmbeddedChunk[]> {
    const embeddedChunks: EmbeddedChunk[] = [];
    
    // Batch chunks for efficient API usage
    const batchSize = 20;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      const texts = batch.map(chunk => this.chunkToText(chunk));
      const embeddings = await this.openaiClient.embedBatch(texts);
      
      for (let j = 0; j < batch.length; j++) {
        embeddedChunks.push({
          ...batch[j],
          embedding: embeddings[j],
          embedding_model: 'text-embedding-3-large'
        });
      }
    }
    
    return embeddedChunks;
  }
  
  private chunkToText(chunk: SemanticChunk): string {
    // Create searchable text representation
    const messages = chunk.messages.map(msg => 
      `${msg.role}: ${msg.content}`
    ).join('\n');
    
    const context = [
      `Project: ${chunk.project_path}`,
      `Time: ${chunk.start_timestamp} to ${chunk.end_timestamp}`,
      chunk.summary ? `Summary: ${chunk.summary}` : '',
      chunk.topics ? `Topics: ${chunk.topics.join(', ')}` : '',
      `Conversation:\n${messages}`
    ].filter(Boolean).join('\n\n');
    
    return context;
  }
}
```

### 5. Storage in LanceDB

```typescript
import * as lancedb from 'lancedb';

class TranscriptStorage {
  private db: lancedb.Database;
  private table: lancedb.Table;
  
  async initialize(): Promise<void> {
    this.db = await lancedb.connect(
      path.join(os.homedir(), '.camille/memory/transcripts')
    );
    
    // Create or open table
    try {
      this.table = await this.db.openTable('conversation_chunks');
    } catch {
      this.table = await this.db.createTable('conversation_chunks', [
        {
          chunk_id: 'chunk_1',
          session_id: 'session_1',
          project_path: '/path/to/project',
          start_timestamp: '2024-01-01T00:00:00Z',
          end_timestamp: '2024-01-01T00:05:00Z',
          message_count: 10,
          content: 'conversation text',
          summary: 'chunk summary',
          topics: ['topic1', 'topic2'],
          embedding: Array(1536).fill(0),  // dimension matches model
          metadata: {}
        }
      ]);
    }
  }
  
  async storeChunks(chunks: EmbeddedChunk[]): Promise<void> {
    const records = chunks.map(chunk => ({
      chunk_id: chunk.id,
      session_id: chunk.session_id,
      project_path: chunk.project_path,
      start_timestamp: chunk.start_timestamp,
      end_timestamp: chunk.end_timestamp,
      message_count: chunk.messages.length,
      content: this.serializeMessages(chunk.messages),
      summary: chunk.summary || '',
      topics: chunk.topics || [],
      embedding: chunk.embedding,
      metadata: {
        model: chunk.embedding_model,
        indexed_at: new Date().toISOString()
      }
    }));
    
    await this.table.add(records);
  }
  
  private serializeMessages(messages: TranscriptMessage[]): string {
    // Store full message content for retrieval
    return JSON.stringify(messages);
  }
}
```

## Hook Response Format

```typescript
interface HookResponse {
  status: 'success' | 'error';
  message?: string;
  stats?: {
    messages_processed: number;
    chunks_created: number;
    embeddings_generated: number;
    processing_time_ms: number;
  };
}

// Success response (exit 0)
console.log(JSON.stringify({
  status: 'success',
  message: 'Transcript indexed successfully',
  stats: {
    messages_processed: 42,
    chunks_created: 8,
    embeddings_generated: 8,
    processing_time_ms: 1234
  }
}));

// Error response (exit 2)
console.error('Failed to process transcript: ' + error.message);
process.exit(2);
```

## Configuration

```typescript
interface MemoryHookConfig {
  enabled: boolean;
  chunk_size: {
    min_tokens: number;
    max_tokens: number;
  };
  embedding: {
    model: string;
    batch_size: number;
  };
  storage: {
    max_chunks_per_session: number;
    retention_days: number;
  };
  processing: {
    incremental: boolean;
    parallel_chunks: number;
  };
}
```

## Error Handling

1. **Transcript Not Found**: Log warning, exit 0 (non-blocking)
2. **Database Connection Failed**: Log error, exit 2 (blocking)
3. **Embedding API Failed**: Retry with backoff, then exit 2
4. **Out of Memory**: Reduce batch size, continue processing
5. **Corrupted Transcript**: Skip corrupted lines, process rest

## Performance Considerations

1. **Incremental Processing**: Only process new messages
2. **Batch Embeddings**: Process 20 chunks at a time
3. **Async Operations**: Use parallel processing where possible
4. **Memory Management**: Stream large transcripts
5. **Checkpoint Frequently**: Save progress every 100 messages

## Privacy and Security

1. **Local Storage**: All data stored locally in user's home directory
2. **No Automatic Sharing**: Peer sharing requires explicit configuration
3. **Encryption**: Optional encryption at rest for sensitive projects
4. **Access Control**: File permissions restrict access to user only
5. **Audit Logging**: Track all access to transcript data

## Integration Points

- [Implementation Plan](./implementation-plan.md): Overall architecture
- [Database Research](./database-research.md): LanceDB details
- [MCP Tools Design](./mcp-tools-design.md): Search interface
- [Peer-to-Peer Design](./peer-to-peer-design.md): Sharing mechanism