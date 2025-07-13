/**
 * Kuzu implementation of the GraphDB interface
 */

import * as kuzu from 'kuzu';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { GraphDB, CodeNode, CodeEdge, GraphQueryResult } from './graph-db.js';
import { logger } from '../../logger.js';

export class KuzuGraphDB implements GraphDB {
  private db?: kuzu.Database;
  private conn?: kuzu.Connection;
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
      this.db = new kuzu.Database(this.dbPath);
      this.conn = new kuzu.Connection(this.db);
      
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
      const metadata = JSON.stringify(node.metadata || {}).replace(/'/g, "''");
      await this.conn.execute(
        `CREATE (n:CodeObject {
          id: '${node.id}',
          type: '${node.type}',
          name: '${node.name.replace(/'/g, "''")}}',
          file: '${node.file.replace(/'/g, "''")}}',
          line: ${node.line},
          col: ${node.column || 'NULL'},
          metadata: '${metadata}'
        })`
      );
      
      return node.id;
    } catch (error) {
      logger.error('Failed to add node', { error, node });
      throw error;
    }
  }

  async addNodes(nodes: CodeNode[]): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Batch insert for better performance
      for (const node of nodes) {
        const metadata = JSON.stringify(node.metadata || {}).replace(/'/g, "''");
        await this.conn.execute(
          `CREATE (n:CodeObject {
            id: '${node.id}',
            type: '${node.type}',
            name: '${node.name.replace(/'/g, "''")}}',
            file: '${node.file.replace(/'/g, "''")}}',
            line: ${node.line},
            col: ${node.column || 'NULL'},
            metadata: '${metadata}'
          })`
        );
      }
    } catch (error) {
      logger.error('Failed to add nodes', { error });
      throw error;
    }
  }

  async addEdge(edge: CodeEdge): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const metadata = JSON.stringify(edge.metadata || {}).replace(/'/g, "''");
      await this.conn.execute(
        `MATCH (a:CodeObject {id: '${edge.source}'}), (b:CodeObject {id: '${edge.target}'})
         CREATE (a)-[r:${edge.relationship.toUpperCase()} {
           metadata: '${metadata}'
         }]->(b)`
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
        await this.conn.execute(
          `MATCH (a:CodeObject {id: '${edge.source}'}), (b:CodeObject {id: '${edge.target}'})
           CREATE (a)-[r:${edge.relationship.toUpperCase()} {
             metadata: '${metadata}'
           }]->(b)`
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
      const result = await this.conn.execute(cypherQuery);
      const records = await result.getAllObjects();
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
      // Delete all relationships first
      await this.conn.execute('MATCH (n)-[r]-() DELETE r');
      // Then delete all nodes
      await this.conn.execute('MATCH (n) DELETE n');
      
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
      await this.conn.execute(`
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
        await this.conn.execute(`
          CREATE REL TABLE IF NOT EXISTS ${rel}(
            FROM CodeObject TO CodeObject,
            metadata STRING
          )
        `);
      }

      // Create indexes for better performance
      await this.conn.execute('CREATE INDEX IF NOT EXISTS idx_code_type ON CodeObject(type)');
      await this.conn.execute('CREATE INDEX IF NOT EXISTS idx_code_name ON CodeObject(name)');
      await this.conn.execute('CREATE INDEX IF NOT EXISTS idx_code_file ON CodeObject(file)');
      
      logger.info('Initialized Kuzu schema');
    } catch (error) {
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