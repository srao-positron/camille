/**
 * Storage provider types
 */

export interface MemoryChunk {
  chunkId: string;
  content: string;
  metadata: {
    sessionId?: string;
    timestamp?: string;
    filePaths?: string[];
    messageType?: 'user' | 'assistant';
    hasCode?: boolean;
    codeLanguage?: string;
    summary?: string;
    [key: string]: any;
  };
}

export interface CodeFile {
  path: string;
  content: string;
  language?: string;
  lastModified?: string;
  metadata?: Record<string, any>;
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: Record<string, any>;
  chunkId: string;
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  metadata: Record<string, any>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  metadata?: Record<string, any>;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StorageProvider {
  // Memory operations
  addMemory(sessionId: string, chunk: MemoryChunk): Promise<void>;
  searchMemories(query: string, limit?: number): Promise<SearchResult[]>;
  
  // Code operations
  addCodeFile(projectPath: string, file: CodeFile): Promise<void>;
  queryGraph(query: string): Promise<GraphResult>;
  
  // Lifecycle
  close(): Promise<void>;
}