/**
 * Kuzu implementation of the GraphDB interface
 */

import { Database, Connection } from 'kuzu';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { GraphDB, CodeNode, CodeEdge, GraphQueryResult } from './graph-db.js';
import { logger } from '../../logger.js';

export class KuzuGraphDB implements GraphDB {
  private db?: any;
  private conn?: any;
  private readonly dbPath: string;
  private initialized = false;

  constructor() {
    // Use the home directory path that will be created automatically
    this.dbPath = path.join(os.homedir(), '.camille', 'memory', 'graph');
  }

  private escapeForCypher(value: string): string {
    // Escape single quotes by doubling them for Cypher string literals
    // This is the standard way to escape single quotes in Cypher
    return value
      .replace(/\\/g, '\\\\') // Escape backslashes first
      .replace(/'/g, "''") // Escape single quotes by doubling them
      .replace(/[\r\n]+/g, ' ') // Replace newlines with spaces
      .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
  }

  private escapeMetadataForCypher(metadata: any): string {
    // Convert metadata to JSON, then escape it properly for Cypher
    const jsonStr = JSON.stringify(metadata || {});
    // For JSON strings inside Cypher strings, we need to escape differently
    return jsonStr
      .replace(/\\/g, '\\\\') // Escape backslashes
      .replace(/'/g, "''") // Double single quotes for Cypher
      .replace(/"/g, '\\"'); // Escape double quotes for JSON
  }

  async connect(): Promise<void> {
    try {
      // Ensure directory exists
      await this.ensureDirectoryExists();
      
      // Connect to Kuzu
      this.db = new Database(this.dbPath);
      this.conn = new Connection(this.db);
      
      // Initialize schema if needed
      if (!this.initialized) {
        await this.initializeSchema();
        this.initialized = true;
      }
      
      logger.info('Connected to Kuzu graph database');
    } catch (error) {
      logger.error('Failed to connect to Kuzu', { error });
      throw error;
    }
  }

  async addNode(node: CodeNode): Promise<string> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      logger.debug('Adding node to graph database', { 
        nodeId: node.id, 
        nodeType: node.type,
        nodeName: node.name,
        file: node.file,
        line: node.line,
        column: node.column
      });
      
      const metadata = this.escapeMetadataForCypher(node.metadata);
      let query = `MERGE (n:CodeObject {id: '${this.escapeForCypher(node.id)}'})
        ON CREATE SET 
          n.type = '${this.escapeForCypher(node.type)}',
          n.name = '${this.escapeForCypher(node.name)}',
          n.file = '${this.escapeForCypher(node.file)}',
          n.line = ${node.line},
          n.col = ${node.column || 0},
          n.metadata = '${metadata}'`;
      
      // Add embeddings if provided
      if (node.name_embedding) {
        query += `,
          n.name_embedding = [${node.name_embedding.join(',')}]`;
      }
      if (node.summary_embedding) {
        query += `,
          n.summary_embedding = [${node.summary_embedding.join(',')}]`;
      }
      
      query += `
        ON MATCH SET 
          n.type = '${this.escapeForCypher(node.type)}',
          n.name = '${this.escapeForCypher(node.name)}',
          n.file = '${this.escapeForCypher(node.file)}',
          n.line = ${node.line},
          n.col = ${node.column || 0},
          n.metadata = '${metadata}'`;
      
      // Add embeddings for MATCH as well
      if (node.name_embedding) {
        query += `,
          n.name_embedding = [${node.name_embedding.join(',')}]`;
      }
      if (node.summary_embedding) {
        query += `,
          n.summary_embedding = [${node.summary_embedding.join(',')}]`;
      }
      
      logger.debug('Executing Kuzu query', { query });
      await this.conn.query(query);
      logger.debug('Node added successfully', { nodeId: node.id });
      
      return node.id;
    } catch (error) {
      logger.error('Failed to add node', { 
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined
        }, 
        node: {
          id: node.id,
          type: node.type,
          name: node.name,
          file: node.file,
          line: node.line,
          column: node.column
        }
      });
      throw error;
    }
  }

  async addNodes(nodes: CodeNode[]): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      logger.debug('Adding batch of nodes to graph database', { 
        nodeCount: nodes.length,
        nodeTypes: nodes.map(n => n.type).join(', ')
      });
      
      // Batch insert for better performance
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        logger.debug(`Processing node ${i + 1}/${nodes.length}`, {
          nodeId: node.id,
          nodeType: node.type,
          nodeName: node.name
        });
        
        const metadata = this.escapeMetadataForCypher(node.metadata);
        let query = `MERGE (n:CodeObject {id: '${this.escapeForCypher(node.id)}'})
          ON CREATE SET 
            n.type = '${this.escapeForCypher(node.type)}',
            n.name = '${this.escapeForCypher(node.name)}',
            n.file = '${this.escapeForCypher(node.file)}',
            n.line = ${node.line},
            n.col = ${node.column || 0},
            n.metadata = '${metadata}'`;
        
        // Add embeddings if provided
        if (node.name_embedding) {
          query += `,
            n.name_embedding = [${node.name_embedding.join(',')}]`;
        }
        if (node.summary_embedding) {
          query += `,
            n.summary_embedding = [${node.summary_embedding.join(',')}]`;
        }
        
        query += `
          ON MATCH SET 
            n.type = '${this.escapeForCypher(node.type)}',
            n.name = '${this.escapeForCypher(node.name)}',
            n.file = '${this.escapeForCypher(node.file)}',
            n.line = ${node.line},
            n.col = ${node.column || 0},
            n.metadata = '${metadata}'`;
        
        // Add embeddings for MATCH as well
        if (node.name_embedding) {
          query += `,
            n.name_embedding = [${node.name_embedding.join(',')}]`;
        }
        if (node.summary_embedding) {
          query += `,
            n.summary_embedding = [${node.summary_embedding.join(',')}]`;
        }
        
        logger.debug('Executing query for node', { query });
        await this.conn.query(query);
      }
      
      logger.debug('All nodes added successfully', { nodeCount: nodes.length });
    } catch (error) {
      logger.error('Failed to add nodes', { 
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined
        },
        nodeCount: nodes.length
      });
      throw error;
    }
  }

  async addEdge(edge: CodeEdge): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const metadata = this.escapeMetadataForCypher(edge.metadata);
      await this.conn.query(
        `MATCH (a:CodeObject {id: '${this.escapeForCypher(edge.source)}'}), (b:CodeObject {id: '${this.escapeForCypher(edge.target)}'})\n         CREATE (a)-[r:${edge.relationship.toUpperCase()} {\n           metadata: '${metadata}'\n         }]->(b)`
      );
    } catch (error) {
      logger.error('Failed to add edge', { error, edge });
      throw error;
    }
  }

  async addEdges(edges: CodeEdge[]): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      for (const edge of edges) {
        const metadata = this.escapeMetadataForCypher(edge.metadata);
        await this.conn.query(
          `MATCH (a:CodeObject {id: '${this.escapeForCypher(edge.source)}'}), (b:CodeObject {id: '${this.escapeForCypher(edge.target)}'})\n           CREATE (a)-[r:${edge.relationship.toUpperCase()} {\n             metadata: '${metadata}'\n           }]->(b)`
        );
      }
    } catch (error) {
      logger.error('Failed to add edges', { error });
      throw error;
    }
  }

  async query(cypherQuery: string, params?: Record<string, any>): Promise<any[]> {
    logger.info('🔍 KuzuDB.query START', { cypherQuery, params });
    
    if (!this.conn) {
      logger.error('❌ KuzuDB.query FAILED - Not connected');
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      logger.info('⚡ Executing Cypher query in Kuzu');
      const result = await this.conn.query(cypherQuery);
      const records = await result.getAll();
      
      logger.info('✅ KuzuDB.query SUCCESS', { 
        cypherQuery,
        recordCount: records.length,
        firstRecord: records[0] || 'none',
        sampleRecords: records.slice(0, 3)
      });
      
      return records;
    } catch (error) {
      logger.error('❌ KuzuDB.query FAILED', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n'),
          name: error.name
        } : error,
        query: cypherQuery 
      });
      throw error;
    }
  }

  async findNodes(type?: string, name?: string): Promise<CodeNode[]> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    let cypherQuery = 'MATCH (n:CodeObject)';
    const conditions: string[] = [];

    if (type) {
      conditions.push(`n.type = '${type}'`);
    }

    if (name) {
      // Support wildcard searches
      if (name.includes('*')) {
        const pattern = name.replace(/\*/g, '.*');
        conditions.push(`n.name =~ '${pattern}'`);
      } else {
        conditions.push(`n.name = '${this.escapeForCypher(name)}'`);
      }
    }

    if (conditions.length > 0) {
      cypherQuery += ' WHERE ' + conditions.join(' AND ');
    }

    cypherQuery += ' RETURN n';

    const results = await this.query(cypherQuery);
    
    if (!results || results.length === 0) {
      return [];
    }
    
    return results
      .filter(record => record && record.n)
      .map(record => this.parseNode(record.n));
  }

  async getRelationships(
    nodeId: string, 
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<GraphQueryResult> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    let cypherQuery: string;
    
    switch (direction) {
      case 'in':
        cypherQuery = `
          MATCH (n:CodeObject {id: '${this.escapeForCypher(nodeId)}'})<-[r]-(m:CodeObject)
          RETURN n, r, m
        `;
        break;
      case 'out':
        cypherQuery = `
          MATCH (n:CodeObject {id: '${this.escapeForCypher(nodeId)}'})-[r]->(m:CodeObject)
          RETURN n, r, m
        `;
        break;
      case 'both':
        cypherQuery = `
          MATCH (n:CodeObject {id: '${this.escapeForCypher(nodeId)}'})-[r]-(m:CodeObject)
          RETURN n, r, m
        `;
        break;
    }

    const results = await this.query(cypherQuery);
    
    const nodes: Map<string, CodeNode> = new Map();
    const edges: CodeEdge[] = [];

    for (const record of results) {
      const sourceNode = this.parseNode(record.n);
      const targetNode = this.parseNode(record.m);
      
      nodes.set(sourceNode.id, sourceNode);
      nodes.set(targetNode.id, targetNode);
      
      edges.push({
        source: sourceNode.id,
        target: targetNode.id,
        relationship: record.r.label.toLowerCase() as any,
        metadata: JSON.parse(record.r.properties.metadata || '{}')
      });
    }

    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }

  async findPath(sourceId: string, targetId: string): Promise<GraphQueryResult> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    const cypherQuery = `
      MATCH p = shortestPath((a:CodeObject {id: '${this.escapeForCypher(sourceId)}'})-[*]-(b:CodeObject {id: '${this.escapeForCypher(targetId)}'}))
      RETURN p
    `;

    const results = await this.query(cypherQuery);
    
    if (results.length === 0) {
      return { nodes: [], edges: [] };
    }

    const path = results[0].p;
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];

    // Extract nodes and relationships from path
    for (let i = 0; i < path.nodes.length; i++) {
      nodes.push(this.parseNode(path.nodes[i]));
      
      if (i < path.relationships.length) {
        const rel = path.relationships[i];
        edges.push({
          source: nodes[i].id,
          target: nodes[i + 1]?.id,
          relationship: rel.label.toLowerCase() as any,
          metadata: JSON.parse(rel.properties.metadata || '{}')
        });
      }
    }

    return { nodes, edges };
  }

  async clear(): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Clear all data - Kuzu syntax
      await this.conn.query('MATCH (n)-[r]-() DELETE r');
      await this.conn.query('MATCH (n) DELETE n');
      
      logger.info('Cleared all data from graph database');
    } catch (error) {
      logger.error('Failed to clear graph database', { error });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.conn) {
      // Kuzu doesn't have explicit connection closing
      this.conn = undefined;
    }
    if (this.db) {
      this.db = undefined;
    }
  }

  /**
   * Get the schema of the graph database
   */
  async getSchema(): Promise<string> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const schema: string[] = [];
      
      // Get node tables
      schema.push('Node Tables:');
      schema.push('- CodeObject:');
      schema.push('  - id: STRING (PRIMARY KEY)');
      schema.push('  - type: STRING (function, class, interface, module, variable)');
      schema.push('  - name: STRING');
      schema.push('  - file: STRING');
      schema.push('  - line: INT64');
      schema.push('  - col: INT64');
      schema.push('  - metadata: STRING (JSON)');
      schema.push('  - name_embedding: DOUBLE[768] (vector for semantic search)');
      schema.push('  - summary_embedding: DOUBLE[768] (vector for summary search)');
      schema.push('');
      
      // Get relationship tables
      schema.push('Relationship Tables:');
      const relationships = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES'];
      for (const rel of relationships) {
        schema.push(`- ${rel}: FROM CodeObject TO CodeObject`);
      }
      
      return schema.join('\n');
    } catch (error) {
      logger.error('Failed to get schema', { error });
      throw error;
    }
  }

  /**
   * Create vector indices for semantic search
   */
  async createVectorIndices(): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Create vector index on name embeddings
      await this.conn.query(`
        CALL CREATE_VECTOR_INDEX(
          'CodeObject',
          'name_vector_index',
          'name_embedding'
        )
      `);
      
      // Create vector index on summary embeddings
      await this.conn.query(`
        CALL CREATE_VECTOR_INDEX(
          'CodeObject',
          'summary_vector_index',
          'summary_embedding'
        )
      `);
      
      logger.info('Created vector indices successfully');
    } catch (error) {
      // Indices might already exist, log but don't throw
      logger.debug('Vector indices might already exist', { error });
    }
  }

  /**
   * Search using vector similarity
   */
  async vectorSearch(
    queryEmbedding: number[], 
    indexName: string, 
    limit: number = 10
  ): Promise<CodeNode[]> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const results = await this.conn.query(`
        CALL QUERY_VECTOR_INDEX(
          'CodeObject',
          $indexName,
          $queryEmbedding,
          $limit
        )
        RETURN node, distance
        ORDER BY distance
        LIMIT $limit
      `, {
        indexName,
        queryEmbedding,
        limit
      });
      
      return results.map((record: any) => this.parseNode(record.node));
    } catch (error) {
      logger.error('Vector search failed', { error, indexName });
      return [];
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected');
    }

    try {
      // Create node table with embedding support
      await this.conn.query(`
        CREATE NODE TABLE IF NOT EXISTS CodeObject(
          id STRING PRIMARY KEY,
          type STRING,
          name STRING,
          file STRING,
          line INT64,
          col INT64,
          metadata STRING,
          name_embedding DOUBLE[],
          summary_embedding DOUBLE[]
        )
      `);

      // Create relationship tables for each type
      const relationships = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES'];
      
      for (const rel of relationships) {
        await this.conn.query(`
          CREATE REL TABLE IF NOT EXISTS ${rel}(
            FROM CodeObject TO CodeObject,
            metadata STRING
          )
        `);
      }

      // Create indexes for better performance (Kuzu doesn't support IF NOT EXISTS for indexes)
      try {
        await this.conn.query('CREATE INDEX idx_code_type ON CodeObject(type)');
      } catch (e) {
        // Index might already exist, ignore error
      }
      try {
        await this.conn.query('CREATE INDEX idx_code_name ON CodeObject(name)');
      } catch (e) {
        // Index might already exist, ignore error
      }
      try {
        await this.conn.query('CREATE INDEX idx_code_file ON CodeObject(file)');
      } catch (e) {
        // Index might already exist, ignore error
      }
      
      logger.info('Initialized Kuzu schema');
    } catch (error) {
      // Better error logging
      const errorInfo = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
        toString: error?.toString ? error.toString() : String(error)
      };
      
      logger.error('Failed to initialize schema', { 
        error: errorInfo,
        dbPath: this.dbPath 
      });
      
      // Don't throw, just log - the database might still work
      this.initialized = true; // Mark as initialized to avoid retry loops
    }
  }

  private parseNode(nodeData: any): CodeNode {
    try {
      // Handle different possible data structures from Kuzu
      const props = nodeData.properties || nodeData;
      
      // Debug log to understand the structure
      if (!props.id) {
        logger.debug('ParseNode received data without id', { 
          nodeData,
          keys: Object.keys(nodeData || {}),
          hasProperties: !!nodeData.properties
        });
      }
      
      return {
        id: props.id || '',
        type: props.type || 'variable',
        name: props.name || '',
        file: props.file || '',
        line: props.line || 0,
        column: props.col || 0,
        metadata: props.metadata ? JSON.parse(props.metadata) : {}
      };
    } catch (error) {
      logger.error('Failed to parse node', { 
        error,
        nodeData,
        nodeDataType: typeof nodeData,
        nodeDataKeys: nodeData ? Object.keys(nodeData) : []
      });
      throw error;
    }
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.mkdir(this.dbPath, { recursive: true });
    } catch (error) {
      logger.error('Failed to create database directory', { error, path: this.dbPath });
      throw error;
    }
  }
  
  isReady(): boolean {
    return this.initialized && this.conn !== null;
  }
  
  async getNodeCount(): Promise<number> {
    if (!this.conn) {
      return 0;
    }
    
    try {
      const result = await this.query('MATCH (n:CodeObject) RETURN COUNT(n) as count');
      return result[0]?.count || 0;
    } catch (error) {
      logger.error('Failed to get node count', { error });
      return 0;
    }
  }
  
  async findNodesByNameAndFile(name: string, file: string, type?: string): Promise<CodeNode[]> {
    if (!this.conn) {
      return [];
    }
    
    try {
      let cypherQuery = `
        MATCH (n:CodeObject)
        WHERE n.name = '${this.escapeForCypher(name)}'
          AND n.file = '${this.escapeForCypher(file)}'
      `;
      
      if (type) {
        cypherQuery += ` AND n.type = '${this.escapeForCypher(type)}'`;
      }
      
      cypherQuery += ' RETURN n';
      
      const results = await this.query(cypherQuery);
      return results
        .filter(record => record && record.n)
        .map(record => this.parseNode(record.n));
    } catch (error) {
      logger.error('Failed to find nodes by name and file', { error, name, file, type });
      return [];
    }
  }
  
  async getEdgeCount(): Promise<number> {
    if (!this.conn) {
      return 0;
    }
    
    try {
      const result = await this.query('MATCH ()-[r]->() RETURN COUNT(r) as count');
      return result[0]?.count || 0;
    } catch (error) {
      logger.error('Failed to get edge count', { error });
      return 0;
    }
  }
}
