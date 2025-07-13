/**
 * Tests for graph database abstractions
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { KuzuGraphDB } from '../../src/memory/databases/kuzu-db';
import { GraphDB, CodeNode, CodeEdge } from '../../src/memory/databases/graph-db';

describe('GraphDB Abstraction', () => {
  let graphDB: GraphDB;
  let testDbPath: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDbPath = path.join(os.tmpdir(), 'camille-test-graph-' + Date.now());
    process.env.CAMILLE_CONFIG_DIR = testDbPath;
    
    graphDB = new KuzuGraphDB();
  });

  afterEach(async () => {
    // Clean up
    if (graphDB) {
      try {
        await graphDB.clear();
        await graphDB.close();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    
    // Remove test directory
    try {
      await fs.rm(testDbPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('KuzuGraphDB', () => {
    it('should create database directory automatically on connect', async () => {
      // Directory should not exist before connect
      const dbPath = path.join(testDbPath, '.camille', 'memory', 'graph');
      await expect(fs.access(dbPath)).rejects.toThrow();

      // Connect should create the directory
      await graphDB.connect();

      // Directory should now exist
      await expect(fs.access(dbPath)).resolves.toBeUndefined();
    });

    it('should connect successfully', async () => {
      await expect(graphDB.connect()).resolves.toBeUndefined();
    });

    it('should add a node', async () => {
      await graphDB.connect();

      const node: CodeNode = {
        id: 'test-func-1',
        type: 'function',
        name: 'testFunction',
        file: '/src/test.ts',
        line: 10,
        column: 5,
        metadata: { visibility: 'public' }
      };

      const id = await graphDB.addNode(node);
      expect(id).toBe('test-func-1');
    });

    it('should add multiple nodes in batch', async () => {
      await graphDB.connect();

      const nodes: CodeNode[] = [
        {
          id: 'class-1',
          type: 'class',
          name: 'TestClass',
          file: '/src/test.ts',
          line: 1
        },
        {
          id: 'method-1',
          type: 'function',
          name: 'testMethod',
          file: '/src/test.ts',
          line: 5
        },
        {
          id: 'method-2',
          type: 'function',
          name: 'anotherMethod',
          file: '/src/test.ts',
          line: 10
        }
      ];

      await expect(graphDB.addNodes(nodes)).resolves.toBeUndefined();

      // Verify nodes were added
      const foundNodes = await graphDB.findNodes('function');
      expect(foundNodes.length).toBeGreaterThanOrEqual(2);
    });

    it('should add edges between nodes', async () => {
      await graphDB.connect();

      // Add nodes first
      const classNode: CodeNode = {
        id: 'class-1',
        type: 'class',
        name: 'MyClass',
        file: '/src/class.ts',
        line: 1
      };

      const methodNode: CodeNode = {
        id: 'method-1',
        type: 'function',
        name: 'myMethod',
        file: '/src/class.ts',
        line: 5
      };

      await graphDB.addNode(classNode);
      await graphDB.addNode(methodNode);

      // Add edge
      const edge: CodeEdge = {
        source: 'class-1',
        target: 'method-1',
        relationship: 'defines',
        metadata: { visibility: 'public' }
      };

      await expect(graphDB.addEdge(edge)).resolves.toBeUndefined();
    });

    it('should find nodes by type', async () => {
      await graphDB.connect();

      // Add various nodes
      await graphDB.addNodes([
        { id: 'func-1', type: 'function', name: 'func1', file: '/a.ts', line: 1 },
        { id: 'func-2', type: 'function', name: 'func2', file: '/b.ts', line: 1 },
        { id: 'class-1', type: 'class', name: 'Class1', file: '/c.ts', line: 1 },
        { id: 'var-1', type: 'variable', name: 'var1', file: '/d.ts', line: 1 }
      ]);

      const functions = await graphDB.findNodes('function');
      expect(functions).toHaveLength(2);
      expect(functions.every(n => n.type === 'function')).toBe(true);
    });

    it('should find nodes by name pattern', async () => {
      await graphDB.connect();

      await graphDB.addNodes([
        { id: 'test-1', type: 'function', name: 'testFunction1', file: '/a.ts', line: 1 },
        { id: 'test-2', type: 'function', name: 'testFunction2', file: '/b.ts', line: 1 },
        { id: 'other-1', type: 'function', name: 'otherFunction', file: '/c.ts', line: 1 }
      ]);

      const testFunctions = await graphDB.findNodes(undefined, 'test*');
      expect(testFunctions.length).toBeGreaterThanOrEqual(2);
      expect(testFunctions.every(n => n.name.startsWith('test'))).toBe(true);
    });

    it('should get relationships for a node', async () => {
      await graphDB.connect();

      // Create a simple graph: ClassA -> defines -> methodA, methodA -> calls -> methodB
      await graphDB.addNodes([
        { id: 'class-a', type: 'class', name: 'ClassA', file: '/a.ts', line: 1 },
        { id: 'method-a', type: 'function', name: 'methodA', file: '/a.ts', line: 5 },
        { id: 'method-b', type: 'function', name: 'methodB', file: '/a.ts', line: 10 }
      ]);

      await graphDB.addEdges([
        { source: 'class-a', target: 'method-a', relationship: 'defines' },
        { source: 'method-a', target: 'method-b', relationship: 'calls' }
      ]);

      // Get all relationships for method-a
      const result = await graphDB.getRelationships('method-a', 'both');
      
      expect(result.nodes.length).toBeGreaterThanOrEqual(2); // At least method-a and one connected node
      expect(result.edges.length).toBeGreaterThanOrEqual(1); // At least one edge
    });

    it('should find shortest path between nodes', async () => {
      await graphDB.connect();

      // Create a path: A -> B -> C -> D
      await graphDB.addNodes([
        { id: 'node-a', type: 'function', name: 'funcA', file: '/a.ts', line: 1 },
        { id: 'node-b', type: 'function', name: 'funcB', file: '/b.ts', line: 1 },
        { id: 'node-c', type: 'function', name: 'funcC', file: '/c.ts', line: 1 },
        { id: 'node-d', type: 'function', name: 'funcD', file: '/d.ts', line: 1 }
      ]);

      await graphDB.addEdges([
        { source: 'node-a', target: 'node-b', relationship: 'calls' },
        { source: 'node-b', target: 'node-c', relationship: 'calls' },
        { source: 'node-c', target: 'node-d', relationship: 'calls' }
      ]);

      const path = await graphDB.findPath('node-a', 'node-d');
      
      expect(path.nodes.length).toBeGreaterThanOrEqual(2); // At least start and end
      expect(path.edges.length).toBeGreaterThanOrEqual(1); // At least one edge in path
    });

    it('should execute Cypher queries', async () => {
      await graphDB.connect();

      // Add some data
      await graphDB.addNode({
        id: 'test-node',
        type: 'function',
        name: 'testQuery',
        file: '/test.ts',
        line: 1
      });

      // Execute a simple Cypher query
      const results = await graphDB.query(
        'MATCH (n:CodeObject) WHERE n.name = $name RETURN n',
        { name: 'testQuery' }
      );

      expect(results).toHaveLength(1);
      expect(results[0].n).toBeDefined();
    });

    it('should clear all data', async () => {
      await graphDB.connect();

      // Add some data
      await graphDB.addNodes([
        { id: 'node-1', type: 'function', name: 'func1', file: '/a.ts', line: 1 },
        { id: 'node-2', type: 'function', name: 'func2', file: '/b.ts', line: 1 }
      ]);

      await graphDB.addEdge({
        source: 'node-1',
        target: 'node-2',
        relationship: 'calls'
      });

      // Clear all data
      await graphDB.clear();

      // Verify data is gone
      const nodes = await graphDB.findNodes();
      expect(nodes).toHaveLength(0);
    });

    it('should handle errors gracefully', async () => {
      // Should throw error when not connected
      const node: CodeNode = {
        id: 'test',
        type: 'function',
        name: 'test',
        file: '/test.ts',
        line: 1
      };

      await expect(graphDB.addNode(node)).rejects.toThrow('Database not connected');
      await expect(graphDB.findNodes()).rejects.toThrow('Database not connected');
      await expect(graphDB.query('MATCH (n) RETURN n')).rejects.toThrow('Database not connected');
    });

    it('should handle complex graph structures', async () => {
      await graphDB.connect();

      // Create a more complex graph structure
      // Interface -> Class -> Methods -> Calls between methods
      const nodes: CodeNode[] = [
        { id: 'interface-1', type: 'interface', name: 'IService', file: '/service.ts', line: 1 },
        { id: 'class-1', type: 'class', name: 'ServiceImpl', file: '/service.ts', line: 10 },
        { id: 'method-1', type: 'function', name: 'init', file: '/service.ts', line: 15 },
        { id: 'method-2', type: 'function', name: 'process', file: '/service.ts', line: 20 },
        { id: 'method-3', type: 'function', name: 'cleanup', file: '/service.ts', line: 30 }
      ];

      await graphDB.addNodes(nodes);

      const edges: CodeEdge[] = [
        { source: 'class-1', target: 'interface-1', relationship: 'implements' },
        { source: 'class-1', target: 'method-1', relationship: 'defines' },
        { source: 'class-1', target: 'method-2', relationship: 'defines' },
        { source: 'class-1', target: 'method-3', relationship: 'defines' },
        { source: 'method-1', target: 'method-2', relationship: 'calls' },
        { source: 'method-2', target: 'method-3', relationship: 'calls' }
      ];

      await graphDB.addEdges(edges);

      // Query the complex structure
      const classRelations = await graphDB.getRelationships('class-1', 'out');
      
      // Class should have 4 outgoing relationships (1 implements + 3 defines)
      expect(classRelations.edges.filter(e => e.source === 'class-1')).toHaveLength(4);
    });
  });
});