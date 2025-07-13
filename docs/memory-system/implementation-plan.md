# Camille Memory System Implementation Plan

## Overview

This document outlines the implementation plan for Camille's memory and knowledge system, incorporating:
1. Claude Code transcript memory with PreCompact hook
2. Peer-to-peer memory sharing
3. Code object graph indexing

## Technology Stack

Based on research findings:
- **Vector Database**: LanceDB (embedded, TypeScript native)
- **Graph Database**: Kuzu (embedded, Cypher support)
- **Metadata Store**: SQLite (built-in Node.js support)
- **Network**: HTTPS with self-signed certs + mDNS/Bonjour
- **Memory Cache**: LRU with configurable limits

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code                              │
├─────────────────────────────────────────────────────────────┤
│  PreCompact Hook  │  MCP Tools  │  Code Editor             │
└──────┬────────────┴──────┬───────┴──────────────────────────┘
       │                   │
       ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Camille Memory System                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Transcript │  │   Unified    │  │   Peer-to-Peer   │  │
│  │   Indexer   │  │    Search    │  │     Network      │  │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────┘  │
│         │                │                      │           │
│  ┌──────▼──────┐  ┌──────▼───────┐  ┌─────────▼────────┐  │
│  │   LanceDB   │  │     Kuzu     │  │   REST API +     │  │
│  │  (Vectors)  │  │   (Graph)    │  │     mDNS         │  │
│  └─────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Foundation (Week 1-2)

### 1.1 Database Setup

**Tasks:**
1. Install and configure LanceDB
2. Install and configure Kuzu
3. Create database abstraction layer
4. Set up SQLite for metadata

**File Structure:**
```typescript
// src/memory/databases/vector-db.ts
export interface VectorDB {
  connect(): Promise<void>;
  index(embedding: number[], metadata: any): Promise<string>;
  search(embedding: number[], limit: number): Promise<SearchResult[]>;
  close(): Promise<void>;
}

// src/memory/databases/lance-db.ts
export class LanceVectorDB implements VectorDB {
  // LanceDB implementation
}

// src/memory/databases/graph-db.ts
export interface GraphDB {
  connect(): Promise<void>;
  addNode(node: CodeNode): Promise<string>;
  addEdge(edge: CodeEdge): Promise<void>;
  query(cypher: string): Promise<any[]>;
  close(): Promise<void>;
}
```

### 1.2 PreCompact Hook Implementation

**Hook Configuration:**
```typescript
// src/memory/hooks/precompact-hook.ts
export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  project_path: string;
  compaction_reason: 'size' | 'time' | 'manual';
}

export class PreCompactHook {
  async run(input: PreCompactInput): Promise<HookResult> {
    // 1. Read transcript
    // 2. Diff with last processed position
    // 3. Extract new messages
    // 4. Generate embeddings
    // 5. Store in LanceDB
    // 6. Update checkpoint
  }
}
```

### 1.3 Memory Configuration

**Configuration Schema:**
```typescript
interface MemoryConfig {
  enabled: boolean;
  maxMemoryMB: number;
  databases: {
    vector: {
      type: 'lancedb';
      path: string;
      cacheSize: number;
    };
    graph: {
      type: 'kuzu';
      path: string;
      cacheSize: number;
    };
  };
  indexing: {
    chunkSize: number;        // Characters per chunk
    chunkOverlap: number;     // Overlap between chunks
    embeddingModel: string;   // OpenAI model for embeddings
  };
  peer: {
    enabled: boolean;
    port: number;
    apiKey: string;
    allowIndirect: boolean;
  };
}
```

## Phase 2: Transcript Memory (Week 3-4)

### 2.1 Transcript Processing Pipeline

```typescript
class TranscriptProcessor {
  // 1. Message Extraction
  extractMessages(transcript: string): Message[] {
    // Parse JSONL format
    // Extract human/assistant messages
    // Preserve metadata
  }

  // 2. Chunking Strategy
  createChunks(messages: Message[]): Chunk[] {
    // Semantic chunking based on:
    // - Topic continuity
    // - Message boundaries
    // - Maximum chunk size
  }

  // 3. Embedding Generation
  async generateEmbeddings(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    // Use OpenAI embeddings
    // Batch for efficiency
    // Handle rate limits
  }

  // 4. Storage
  async store(embeddedChunks: EmbeddedChunk[]): Promise<void> {
    // Store in LanceDB
    // Update indices
    // Track progress
  }
}
```

### 2.2 MCP Tools for Memory

**Tool: recall_previous_discussions**
```typescript
{
  name: "recall_previous_discussions",
  description: `Search through our entire conversation history across all projects. 
                I can help you remember solutions we've discussed, code patterns 
                we've implemented, and decisions we've made together.`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What you want to remember or find"
      },
      project_filter: {
        type: "string",
        description: "Optional: limit to specific project",
        optional: true
      },
      time_range: {
        type: "string",
        description: "Optional: 'today', 'week', 'month', 'all'",
        optional: true
      }
    }
  }
}
```

### 2.3 Discovery Mechanisms

1. **Contextual Injection**:
```typescript
// Detect patterns and inject context
const memoryTriggers = [
  /how did we/i,
  /remember when/i,
  /last time/i,
  /previously/i,
  /before/i
];

if (memoryTriggers.some(trigger => query.match(trigger))) {
  // Automatically search memory and inject results
}
```

2. **Smart Tool Naming**:
- Primary: `recall_previous_discussions`
- Aliases: `search_memory`, `find_past_conversations`
- Context-specific: `find_similar_problems`, `remember_solution`

## Phase 3: Peer-to-Peer Network (Week 5-6)

### 3.1 REST API Design

**Endpoints:**
```typescript
// GET /api/v1/search
interface SearchRequest {
  query: string;
  embedding?: number[];
  limit?: number;
  filters?: {
    project?: string;
    time_range?: string;
    type?: 'transcript' | 'code';
  };
  request_chain?: string[]; // For loop detection
}

// GET /api/v1/status
interface StatusResponse {
  version: string;
  indexed_items: number;
  last_update: Date;
  capabilities: string[];
}

// GET /api/v1/info
interface InfoResponse {
  name: string;
  public_key: string;
  allowed_indirect: boolean;
}
```

### 3.2 mDNS/Bonjour Discovery

```typescript
import * as bonjour from 'bonjour';

class PeerDiscovery {
  private mdns = bonjour();
  
  advertise() {
    this.mdns.publish({
      name: 'camille-' + hostname,
      type: 'camille',
      port: 7860,
      txt: {
        version: '1.0',
        publicKey: this.publicKey
      }
    });
  }
  
  discover(): Promise<Peer[]> {
    return new Promise((resolve) => {
      const browser = this.mdns.find({ type: 'camille' });
      const peers: Peer[] = [];
      
      browser.on('up', (service) => {
        peers.push({
          name: service.name,
          host: service.host,
          port: service.port,
          publicKey: service.txt.publicKey
        });
      });
      
      setTimeout(() => {
        browser.stop();
        resolve(peers);
      }, 5000);
    });
  }
}
```

### 3.3 Request Aggregation

```typescript
class PeerAggregator {
  async search(query: string, options: SearchOptions): Promise<AggregatedResults> {
    // 1. Search local
    const localResults = await this.localSearch(query, options);
    
    // 2. Search peers in parallel
    const peerPromises = this.peers.map(peer => 
      this.searchPeer(peer, query, options)
        .catch(err => ({ peer, error: err }))
    );
    
    const peerResults = await Promise.all(peerPromises);
    
    // 3. Merge and rank
    return this.mergeResults(localResults, peerResults, options.merge);
  }
  
  private mergeResults(
    local: SearchResult[], 
    peers: PeerResult[], 
    merge: boolean
  ): AggregatedResults {
    if (merge) {
      // Combine all results and re-rank by relevance
      const all = [
        ...local.map(r => ({ ...r, source: 'local' })),
        ...peers.flatMap(p => p.results.map(r => ({ ...r, source: p.peer.name })))
      ];
      return all.sort((a, b) => b.score - a.score);
    } else {
      // Keep separate, local first
      return {
        local,
        peers: peers.map(p => ({
          source: p.peer.name,
          results: p.results
        }))
      };
    }
  }
}
```

## Phase 4: Object Graph Index (Week 7-8)

### 4.1 Language Parsers

```typescript
interface CodeParser {
  parse(file: string, content: string): ParseResult;
}

class TypeScriptParser implements CodeParser {
  parse(file: string, content: string): ParseResult {
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest);
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    
    // Extract functions, classes, imports
    ts.forEachChild(ast, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        nodes.push({
          id: generateId(file, node.name),
          type: 'function',
          name: node.name.text,
          file,
          line: getLine(node)
        });
      }
      // ... handle other node types
    });
    
    return { nodes, edges };
  }
}
```

### 4.2 Graph Construction

```typescript
class GraphBuilder {
  async buildGraph(directory: string): Promise<void> {
    const files = await this.findSourceFiles(directory);
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const parser = this.getParser(file);
      const { nodes, edges } = parser.parse(file, content);
      
      // Store in Kuzu
      for (const node of nodes) {
        await this.graphDB.addNode(node);
      }
      
      for (const edge of edges) {
        await this.graphDB.addEdge(edge);
      }
    }
    
    // Build indices
    await this.graphDB.createIndices();
  }
}
```

### 4.3 Unified Search Intelligence

```typescript
class UnifiedSearch {
  async search(query: string): Promise<UnifiedResult> {
    // 1. Analyze query intent
    const intent = this.analyzeIntent(query);
    
    // 2. Route to appropriate search
    if (intent.type === 'structural') {
      // "Find all functions that call X"
      return this.graphSearch(intent.query);
    } else if (intent.type === 'semantic') {
      // "Find code similar to authentication"
      return this.vectorSearch(intent.query);
    } else {
      // Hybrid: both searches
      const [graph, vector] = await Promise.all([
        this.graphSearch(intent.query),
        this.vectorSearch(intent.query)
      ]);
      
      return this.combineResults(graph, vector);
    }
  }
  
  private analyzeIntent(query: string): QueryIntent {
    const structuralKeywords = ['calls', 'extends', 'imports', 'dependency'];
    const isStructural = structuralKeywords.some(kw => 
      query.toLowerCase().includes(kw)
    );
    
    return {
      type: isStructural ? 'structural' : 'semantic',
      query
    };
  }
}
```

## Testing Strategy

### Unit Tests
- Database adapters
- Parser implementations
- Network protocols
- Memory management

### Integration Tests
- End-to-end transcript indexing
- Peer discovery and communication
- Graph construction from real code
- Unified search accuracy

### Performance Tests
- Memory usage under load
- Query response times
- Network latency impact
- Concurrent peer requests

## Deployment Considerations

### Setup Wizard Updates
```typescript
// Add memory configuration to setup wizard
const memoryQuestions = [
  {
    type: 'confirm',
    name: 'enableMemory',
    message: 'Enable conversation memory system?',
    default: true
  },
  {
    type: 'number',
    name: 'maxMemoryMB',
    message: 'Maximum memory usage (MB):',
    default: 2048,
    when: (answers) => answers.enableMemory
  },
  {
    type: 'confirm',
    name: 'enablePeerSharing',
    message: 'Enable peer-to-peer memory sharing?',
    default: false,
    when: (answers) => answers.enableMemory
  }
];
```

### Migration Path
1. Existing users opt-in through setup wizard
2. Gradual indexing of existing transcripts
3. Background graph construction
4. No breaking changes to current functionality

## Success Metrics

1. **Discovery Rate**: % of relevant memory recalls
2. **Query Performance**: <200ms for local, <500ms for peer
3. **Memory Efficiency**: <2GB for typical developer
4. **User Adoption**: 50%+ enable memory features
5. **Peer Network**: Average 2-3 peers per user

## Next Steps

1. Set up development environment with LanceDB and Kuzu
2. Implement PreCompact hook prototype
3. Create proof-of-concept for transcript search
4. Design peer authentication mechanism
5. Build TypeScript parser for graph construction