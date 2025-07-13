/**
 * Memory system type definitions
 */

export interface MemoryConfig {
  enabled: boolean;
  maxMemoryMB: number;
  databases: {
    vector: {
      type: 'lancedb';
      cacheSize: number;
    };
    graph: {
      type: 'kuzu';
      cacheSize: number;
    };
  };
  indexing: {
    chunkSize: number;        // Characters per chunk
    chunkOverlap: number;     // Overlap between chunks
    embeddingModel: string;   // OpenAI model for embeddings
    batchSize: number;        // Batch size for embedding generation
  };
  peer: {
    enabled: boolean;
    port: number;
    apiKey?: string;
    allowIndirect: boolean;
    maxPeers: number;
  };
  transcript: {
    enabled: boolean;
    retentionDays: number;    // How long to keep transcripts
    maxChunksPerSession: number;
  };
}

export interface TranscriptChunk {
  id: string;
  sessionId: string;
  projectPath: string;
  startTimestamp: string;
  endTimestamp: string;
  messages: TranscriptMessage[];
  summary?: string;
  topics?: string[];
  embedding?: number[];
  metadata?: Record<string, any>;
}

export interface TranscriptMessage {
  timestamp: string;
  role: 'human' | 'assistant' | 'system';
  content: string;
  toolUses?: ToolUse[];
  metadata?: {
    model?: string;
    tokenCount?: number;
    [key: string]: any;
  };
}

export interface ToolUse {
  name: string;
  input: any;
  output?: any;
}

export interface SearchFilters {
  project?: string;
  after?: Date;
  before?: Date;
  contentType?: 'conversation' | 'code' | 'decision' | 'all';
  includeSystem?: boolean;
}

export interface MemorySearchResult {
  results: MemoryResult[];
  summary: string;
  stats: {
    totalResults: number;
    sources: { [key: string]: number };
    timeRange: { oldest: Date; newest: Date };
  };
}

export interface MemoryResult {
  id: string;
  type: 'conversation' | 'code' | 'decision';
  content: string;
  context: {
    sessionId: string;
    projectPath: string;
    timestamp: Date;
    participants: string[];
    before?: string;  // Previous message
    after?: string;   // Next message
  };
  relevanceScore: number;
  source: string;  // 'local' or peer name
  highlights: string[];  // Key phrases highlighted
}

export interface PeerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  publicKey?: string;
  capabilities: string[];
  lastSeen: Date;
  status: 'active' | 'inactive' | 'error';
}

// Default configuration
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  maxMemoryMB: 2048,
  databases: {
    vector: {
      type: 'lancedb',
      cacheSize: 512
    },
    graph: {
      type: 'kuzu',
      cacheSize: 256
    }
  },
  indexing: {
    chunkSize: 2000,
    chunkOverlap: 200,
    embeddingModel: 'text-embedding-3-large',
    batchSize: 20
  },
  peer: {
    enabled: false,
    port: 7861,
    allowIndirect: false,
    maxPeers: 10
  },
  transcript: {
    enabled: true,
    retentionDays: 90,
    maxChunksPerSession: 1000
  }
};