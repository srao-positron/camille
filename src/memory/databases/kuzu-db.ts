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
      
      const metadata = JSON.stringify(node.metadata || {}).replace(/'/g, "''");
      const query = `MERGE (n:CodeObject {id: '${node.id.replace(/'/g, "''")}'})
        ON CREATE SET 
          n.type = '${node.type}',
          n.name = '${node.name.replace(/'/g, "''")}',
          n.file = '${node.file.replace(/'/g, "''")}',
          n.line = ${node.line},
          n.col = ${node.column || 0},
          n.metadata = '${metadata}'
        ON MATCH SET 
          n.type = '${node.type}',
          n.name = '${node.name.replace(/'/g, "''")}',
          n.file = '${node.file.replace(/'/g, "''")}',
          n.line = ${node.line},
          n.col = ${node.column || 0},
          n.metadata = '${metadata}'`;
      
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
        
        const metadata = JSON.stringify(node.metadata || {}).replace(/'/g, "''");
        const query = `MERGE (n:CodeObject {id: '${node.id.replace(/'/g, "''")}'})
          ON CREATE SET 
            n.type = '${node.type}',
            n.name = '${node.name.replace(/'/g, "''")}',
            n.file = '${node.file.replace(/'/g, "''")}',
            n.line = ${node.line},
            n.col = ${node.column || 0},
            n.metadata = '${metadata}'
          ON MATCH SET 
            n.type = '${node.type}',
            n.name = '${node.name.replace(/'/g, "''")}',
            n.file = '${node.file.replace(/'/g, "''")}',
            n.line = ${node.line},
            n.col = ${node.column || 0},
            n.metadata = '${metadata}'`;
        
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
      const metadata = JSON.stringify(edge.metadata || {}).replace(/'/g, "''");
      await this.conn.query(
        `MATCH (a:CodeObject {id: '${edge.source.replace(/'/g, "''")}'}), (b:CodeObject {id: '${edge.target.replace(/'/g, "''")}'})\n         CREATE (a)-[r:${edge.relationship.toUpperCase()} {\n           metadata: '${metadata}'\n         }]->(b)`
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
        const metadata = JSON.stringify(edge.metadata || {}).replace(/'/g, "''");
        await this.conn.query(
          `MATCH (a:CodeObject {id: '${edge.source.replace(/'/g, "''")}'}), (b:CodeObject {id: '${edge.target.replace(/'/g, "''")}'})\n           CREATE (a)-[r:${edge.relationship.toUpperCase()} {\n             metadata: '${metadata}'\n           }]->(b)`
        );
      }
    } catch (error) {
      logger.error('Failed to add edges', { error });
      throw error;
    }
  }

  async query(cypherQuery: string, params?: Record<string, any>): Promise<any[]> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const result = await this.conn.query(cypherQuery);
      const records = await result.getAll();
      return records;
    } catch (error) {
      logger.error('Query failed', { error, query: cypherQuery });
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
        conditions.push(`n.name = '${name.replace(/'/g, "''")}'`);
      }
    }

    if (conditions.length > 0) {
      cypherQuery += ' WHERE ' + conditions.join(' AND ');
    }

    cypherQuery += ' RETURN n';

    const results = await this.query(cypherQuery);
    
    return results.map(record => this.parseNode(record.n));
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
          MATCH (n:CodeObject {id: '${nodeId}'})<-[r]-(m:CodeObject)
          RETURN n, r, m
        `;
        break;
      case 'out':
        cypherQuery = `
          MATCH (n:CodeObject {id: '${nodeId}'})-[r]->(m:CodeObject)
          RETURN n, r, m
        `;
        break;
      case 'both':
        cypherQuery = `
          MATCH (n:CodeObject {id: '${nodeId}'})-[r]-(m:CodeObject)
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
      MATCH p = shortestPath((a:CodeObject {id: '${sourceId}'})-[*]-(b:CodeObject {id: '${targetId}'}))
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

  private async initializeSchema(): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected');
    }

    try {
      // Create node table
      await this.conn.query(`
        CREATE NODE TABLE IF NOT EXISTS CodeObject(
          id STRING PRIMARY KEY,
          type STRING,
          name STRING,
          file STRING,
          line INT64,
          col INT64,
          metadata STRING
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
      // Write detailed error to file for debugging
      const fs = require('fs');
      const errorDetails = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
        type: typeof error,
        keys: Object.keys(error || {}),
        timestamp: new Date().toISOString()
      };
      fs.appendFileSync('/tmp/kuzu-schema-debug.log', JSON.stringify(errorDetails, null, 2) + '\n');
      
      logger.error('Failed to initialize schema', { error });
      throw error;
    }
  }

  private parseNode(nodeData: any): CodeNode {
    return {
      id: nodeData.properties.id,
      type: nodeData.properties.type,
      name: nodeData.properties.name,
      file: nodeData.properties.file,
      line: nodeData.properties.line,
      column: nodeData.properties.col,
      metadata: JSON.parse(nodeData.properties.metadata || '{}')
    };
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.mkdir(this.dbPath, { recursive: true });
    } catch (error) {
      logger.error('Failed to create database directory', { error, path: this.dbPath });
      throw error;
    }
  }
}
