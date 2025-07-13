# Embedded Database Research for Camille Memory System

## Executive Summary

After researching embedded databases for Camille's memory and knowledge system, I recommend:

1. **Vector Database**: LanceDB for transcript and code embeddings
2. **Graph Database**: Kuzu for code object graphs
3. **Fallback Option**: SQLite with custom extensions for both needs

## Vector Database Analysis

### LanceDB (Recommended)

**Key Advantages:**
- **Performance**: 100x faster than Parquet, can search 1B vectors in <100ms on MacBook
- **Embedded Architecture**: No server needed, runs in-process with Camille
- **Language Support**: Native TypeScript/JavaScript bindings
- **Storage Efficiency**: Zero-copy versioning for incremental updates
- **Data Format**: Lance format (improved Parquet) with fragment-based loading
- **Multimodal**: Handles text, images, and other unstructured data
- **Implementation**: Rust-based for speed and low resource usage

**Technical Specifications:**
```typescript
// Example LanceDB integration
import * as lancedb from "lancedb";

const db = await lancedb.connect("~/.camille/memory/vectors");
const table = await db.createTable("transcripts", [
  { vector: [1.1, 2.3, 3.4], text: "conversation chunk", session_id: "abc123" }
]);
```

**Limitations:**
- Young project (but more mature than ChromaDB)
- Active development may introduce breaking changes

### ChromaDB (Alternative)

**Key Advantages:**
- Simple, developer-friendly API
- Uses proven technologies (ClickHouse + hnswlib)
- JavaScript client available

**Key Limitations:**
- Still in Alpha release
- Cannot handle nested metadata
- Only one vector field per document
- Requires Python backend even for JS client

### Why LanceDB?

1. **No External Dependencies**: True embedded database
2. **TypeScript Native**: First-class JS/TS support
3. **Performance**: Critical for real-time search across large transcript histories
4. **Incremental Updates**: Perfect for our continuous indexing needs
5. **Storage Efficiency**: Important for transcript storage

## Graph Database Analysis

### Kuzu (Recommended)

**Key Advantages:**
- **True Embedded**: Runs in-process, no server needed
- **Cypher Support**: Industry-standard graph query language
- **Performance**: Built for speed and scalability
- **Language Bindings**: Node.js bindings available
- **ACID Compliant**: Ensures data consistency
- **Schema Flexibility**: Supports both schema-full and schema-free modes

**Technical Specifications:**
```typescript
// Example Kuzu integration
import kuzu from "kuzu";

const db = new kuzu.Database("~/.camille/memory/graph");
const conn = db.connect();

// Create schema for code objects
conn.execute(`
  CREATE NODE TABLE Function(
    name STRING,
    file STRING,
    line INT,
    PRIMARY KEY(file, name)
  )
`);

conn.execute(`
  CREATE REL TABLE calls(
    FROM Function TO Function,
    line INT
  )
`);
```

### LevelGraph (JavaScript Alternative)

**Key Advantages:**
- Pure JavaScript implementation
- Built on LevelDB
- Lightweight and simple
- Triple store model

**Key Limitations:**
- No Cypher support
- Less performant than Kuzu
- Limited query capabilities

### SQLite with Graph Extensions (Fallback)

**Approach:**
```sql
-- Node table
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT,
  name TEXT,
  file TEXT,
  metadata JSON
);

-- Edge table
CREATE TABLE edges (
  source_id TEXT,
  target_id TEXT,
  relationship TEXT,
  metadata JSON,
  FOREIGN KEY (source_id) REFERENCES nodes(id),
  FOREIGN KEY (target_id) REFERENCES nodes(id)
);

-- Indexes for graph traversal
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
```

## Implementation Architecture

### Unified Database Strategy

```
~/.camille/memory/
├── vectors/           # LanceDB vector storage
│   ├── transcripts/   # Conversation embeddings
│   ├── code/          # Code embeddings
│   └── metadata/      # Index metadata
├── graph/             # Kuzu graph database
│   ├── schema/        # Graph schema definitions
│   └── data/          # Graph data files
└── sqlite/            # SQLite for metadata & config
    ├── peers.db       # Peer configuration
    ├── projects.db    # Project metadata
    └── audit.db       # Access logs
```

### Memory Management Strategy

```typescript
interface MemoryConfig {
  maxMemoryMB: number;      // User-configurable
  vectorCacheSize: number;  // LRU cache for vectors
  graphCacheSize: number;   // LRU cache for graph
  evictionPolicy: 'lru' | 'lfu';
}

// Dynamic memory allocation
const availableMemory = os.freemem();
const allocatedMemory = Math.min(
  config.maxMemoryMB * 1024 * 1024,
  availableMemory * 0.5  // Use max 50% of available
);
```

## Performance Considerations

### Vector Search Performance
- LanceDB: ~100ms for 1B vectors
- Index size: ~100 bytes per vector (dim=1536)
- Memory usage: ~1.5GB per 10M vectors

### Graph Query Performance
- Kuzu: Sub-ms for local traversals
- Memory usage: ~50-100 bytes per node/edge
- Supports millions of nodes efficiently

## Integration Plan

### Phase 1: LanceDB Integration
1. Install LanceDB npm package
2. Create vector storage abstraction
3. Implement transcript chunking strategy
4. Build incremental indexing system

### Phase 2: Kuzu Integration
1. Install Kuzu Node.js bindings
2. Design graph schema for supported languages
3. Implement language parsers
4. Build graph construction pipeline

### Phase 3: Memory Management
1. Implement LRU cache layer
2. Add disk spillover mechanism
3. Create memory monitoring system
4. Add configuration options

## Risk Mitigation

### Primary Risks:
1. **LanceDB Stability**: Young project, may have breaking changes
   - Mitigation: Abstract database interface for easy swapping
   
2. **Kuzu Node.js Support**: Bindings may be less mature
   - Mitigation: Fallback to SQLite graph implementation

3. **Memory Constraints**: Large codebases may exceed limits
   - Mitigation: Implement aggressive caching and eviction

## Recommendation

**Go with LanceDB + Kuzu combination because:**

1. **No External Dependencies**: Both are truly embedded
2. **Performance**: Best-in-class for their respective domains
3. **Developer Experience**: Good TypeScript/JavaScript support
4. **Future-Proof**: Active development and growing adoption
5. **Storage Efficiency**: Critical for transcript and code storage

**Implementation Priority:**
1. Start with LanceDB for vector search (most critical)
2. Add Kuzu for graph capabilities (enhancement)
3. Keep SQLite as metadata store and fallback option

## Next Steps

1. Create proof-of-concept with LanceDB for transcript storage
2. Benchmark memory usage and query performance
3. Design abstraction layer for database swapping
4. Implement incremental indexing strategy