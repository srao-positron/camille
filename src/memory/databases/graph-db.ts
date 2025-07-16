/**
 * Graph database abstraction interface
 */

export interface CodeNode {
  id: string;
  type: 'function' | 'class' | 'interface' | 'module' | 'variable';
  name: string;
  file: string;
  line: number;
  column?: number;
  metadata?: Record<string, any>;
  name_embedding?: number[];
  summary_embedding?: number[];
}

export interface CodeEdge {
  source: string;  // source node id
  target: string;  // target node id
  relationship: 'calls' | 'imports' | 'extends' | 'implements' | 'uses' | 'defines';
  metadata?: Record<string, any>;
}

export interface GraphQueryResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
  metadata?: Record<string, any>;
}

export interface GraphDB {
  /**
   * Connect to the graph database
   */
  connect(): Promise<void>;

  /**
   * Add a node to the graph
   * @param node Code node to add
   * @returns Node ID
   */
  addNode(node: CodeNode): Promise<string>;

  /**
   * Add multiple nodes in batch
   * @param nodes Array of nodes to add
   */
  addNodes(nodes: CodeNode[]): Promise<void>;

  /**
   * Add an edge between nodes
   * @param edge Edge to add
   */
  addEdge(edge: CodeEdge): Promise<void>;

  /**
   * Add multiple edges in batch
   * @param edges Array of edges to add
   */
  addEdges(edges: CodeEdge[]): Promise<void>;

  /**
   * Execute a Cypher query
   * @param query Cypher query string
   * @param params Query parameters
   * @returns Query results
   */
  query(query: string, params?: Record<string, any>): Promise<any[]>;

  /**
   * Find nodes by type and name
   * @param type Node type filter
   * @param name Name pattern (supports wildcards)
   * @returns Matching nodes
   */
  findNodes(type?: string, name?: string): Promise<CodeNode[]>;

  /**
   * Get all relationships for a node
   * @param nodeId Node ID
   * @param direction 'in' | 'out' | 'both'
   * @returns Related nodes and edges
   */
  getRelationships(
    nodeId: string, 
    direction?: 'in' | 'out' | 'both'
  ): Promise<GraphQueryResult>;

  /**
   * Find shortest path between two nodes
   * @param sourceId Source node ID
   * @param targetId Target node ID
   * @returns Path as nodes and edges
   */
  findPath(sourceId: string, targetId: string): Promise<GraphQueryResult>;

  /**
   * Clear all data from the graph
   */
  clear(): Promise<void>;

  /**
   * Close database connection
   */
  close(): Promise<void>;

  /**
   * Get the schema of the graph database
   */
  getSchema(): Promise<string>;

  /**
   * Create vector indices for semantic search
   */
  createVectorIndices(): Promise<void>;

  /**
   * Search using vector similarity
   * @param queryEmbedding The query vector
   * @param indexName Name of the vector index to search
   * @param limit Maximum results
   */
  vectorSearch(
    queryEmbedding: number[], 
    indexName: string, 
    limit?: number
  ): Promise<CodeNode[]>;

  /**
   * Find nodes by name and file path
   * @param name The exact name of the node
   * @param file The file path containing the node
   * @param type Optional node type filter
   * @returns Matching nodes
   */
  findNodesByNameAndFile(name: string, file: string, type?: string): Promise<CodeNode[]>;
}