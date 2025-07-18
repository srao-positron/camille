/**
 * Two-pass edge resolution system
 * Resolves edges after all nodes have been created
 */

import { GraphDB, CodeNode, CodeEdge } from './databases/graph-db.js';
import { logger } from '../logger.js';
import * as path from 'path';

export interface PendingEdge {
  sourceId: string;
  targetName: string;
  targetType: string;
  targetFile?: string;    // From imports
  relationship: string;
  metadata: any;
  
  // Resolution hints
  receiver?: string;      // For method calls
  importSource?: string;  // For imported symbols
}

export interface ResolutionStats {
  totalEdges: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  byType: Record<string, number>;
}

export interface ImportMap {
  [symbol: string]: {
    source: string;
    isDefault: boolean;
    isNamespace: boolean;
  };
}

/**
 * Resolves edges between code objects
 */
export class EdgeResolver {
  private graphDB: GraphDB;
  private nodeCache: Map<string, CodeNode[]> = new Map();
  private importMaps: Map<string, ImportMap> = new Map();
  private stats: ResolutionStats = {
    totalEdges: 0,
    resolved: 0,
    unresolved: 0,
    ambiguous: 0,
    byType: {}
  };

  constructor(graphDB: GraphDB) {
    this.graphDB = graphDB;
  }

  /**
   * Build import maps from parsed files
   */
  buildImportMaps(parsedFiles: any[]): void {
    for (const file of parsedFiles) {
      const importMap: ImportMap = {};
      
      for (const imp of file.imports || []) {
        // Resolve import source to absolute path
        const resolvedSource = this.resolveImportPath(imp.source, file.file);
        
        for (const symbol of imp.imports) {
          importMap[symbol] = {
            source: resolvedSource,
            isDefault: imp.isDefault || false,
            isNamespace: imp.isNamespace || false
          };
        }
      }
      
      this.importMaps.set(file.file, importMap);
    }
    
    logger.info('Built import maps', {
      fileCount: this.importMaps.size,
      totalImports: Array.from(this.importMaps.values())
        .reduce((sum, map) => sum + Object.keys(map).length, 0)
    });
  }

  /**
   * Resolve all pending edges
   */
  async resolveEdges(pendingEdges: PendingEdge[]): Promise<ResolutionStats> {
    logger.info('Starting edge resolution', { count: pendingEdges.length });
    this.stats.totalEdges = pendingEdges.length;
    
    // Build node cache for efficient lookup
    await this.buildNodeCache();
    
    // Process edges in batches
    const batchSize = 100;
    const resolvedEdges: CodeEdge[] = [];
    
    for (let i = 0; i < pendingEdges.length; i += batchSize) {
      const batch = pendingEdges.slice(i, i + batchSize);
      const resolved = await Promise.all(
        batch.map(edge => this.resolveEdge(edge))
      );
      
      resolvedEdges.push(...resolved.filter(e => e !== null) as CodeEdge[]);
      
      logger.debug('Edge resolution progress', {
        processed: Math.min(i + batchSize, pendingEdges.length),
        total: pendingEdges.length,
        resolved: resolvedEdges.length
      });
    }
    
    // Write resolved edges to graph
    if (resolvedEdges.length > 0) {
      await this.graphDB.addEdges(resolvedEdges);
    }
    
    logger.info('Edge resolution completed', this.stats);
    return this.stats;
  }

  /**
   * Build cache of all nodes for efficient lookup
   */
  private async buildNodeCache(): Promise<void> {
    logger.info('Building node cache for edge resolution');
    
    // Get all nodes from graph
    const allNodes = await this.graphDB.findNodes();
    
    // Group by name for efficient lookup
    for (const node of allNodes) {
      const key = `${node.name}:${node.type}`;
      if (!this.nodeCache.has(key)) {
        this.nodeCache.set(key, []);
      }
      this.nodeCache.get(key)!.push(node);
    }
    
    logger.info('Node cache built', {
      totalNodes: allNodes.length,
      uniqueKeys: this.nodeCache.size
    });
  }

  /**
   * Resolve a single edge
   */
  private async resolveEdge(pending: PendingEdge): Promise<CodeEdge | null> {
    // Find target node
    const targetNode = await this.findTargetNode(pending);
    
    if (!targetNode) {
      logger.debug('Failed to resolve edge', {
        source: pending.sourceId,
        targetName: pending.targetName,
        targetType: pending.targetType
      });
      this.stats.unresolved++;
      return null;
    }
    
    // Track resolution type
    const resolutionType = this.getResolutionType(pending, targetNode);
    this.stats.byType[resolutionType] = (this.stats.byType[resolutionType] || 0) + 1;
    this.stats.resolved++;
    
    return {
      source: pending.sourceId,
      target: targetNode.id,
      relationship: pending.relationship as any,
      metadata: {
        ...pending.metadata,
        resolved: true,
        resolutionType
      }
    };
  }

  /**
   * Find the target node for an edge
   */
  private async findTargetNode(pending: PendingEdge): Promise<CodeNode | null> {
    const candidates: CodeNode[] = [];
    
    // 1. Try exact match in same file
    const sameFileCandidates = await this.findNodesInFile(
      pending.targetName, 
      pending.targetType,
      this.getFileFromNodeId(pending.sourceId)
    );
    candidates.push(...sameFileCandidates);
    
    // 2. Check imports
    if (candidates.length === 0 && pending.importSource) {
      const importedCandidates = await this.findNodesInFile(
        pending.targetName,
        pending.targetType,
        pending.importSource
      );
      candidates.push(...importedCandidates);
    }
    
    // 3. For method calls, try to find in the receiver's class
    if (candidates.length === 0 && pending.receiver && pending.targetType === 'function') {
      const classCandidates = await this.findMethodInClass(
        pending.targetName,
        pending.receiver,
        this.getFileFromNodeId(pending.sourceId)
      );
      candidates.push(...classCandidates);
    }
    
    // 4. Global search (built-in functions, etc.)
    if (candidates.length === 0) {
      const key = `${pending.targetName}:${pending.targetType}`;
      const globalCandidates = this.nodeCache.get(key) || [];
      candidates.push(...globalCandidates);
    }
    
    // Return best candidate
    if (candidates.length === 1) {
      return candidates[0];
    } else if (candidates.length > 1) {
      // Ambiguous - try to pick the best match
      this.stats.ambiguous++;
      return this.pickBestCandidate(candidates, pending);
    }
    
    return null;
  }

  /**
   * Find nodes in a specific file
   */
  private async findNodesInFile(name: string, type: string, file: string): Promise<CodeNode[]> {
    const key = `${name}:${type}`;
    const candidates = this.nodeCache.get(key) || [];
    return candidates.filter(node => node.file === file);
  }

  /**
   * Find method in a class (handling inheritance)
   */
  private async findMethodInClass(methodName: string, className: string, file: string): Promise<CodeNode[]> {
    // First find the class
    const classKey = `${className}:class`;
    const classes = this.nodeCache.get(classKey) || [];
    const targetClass = classes.find(c => c.file === file) || classes[0];
    
    if (!targetClass) return [];
    
    // Find methods defined by this class
    const definedMethods = await this.graphDB.query(
      `MATCH (c:CodeObject {id: '${targetClass.id}'})-[:DEFINES]->(m:CodeObject {name: '${methodName}', type: 'function'})
       RETURN m`
    );
    
    if (definedMethods.length > 0) {
      return definedMethods.map(r => r.m);
    }
    
    // Check parent classes
    const parentClasses = await this.graphDB.query(
      `MATCH (c:CodeObject {id: '${targetClass.id}'})-[:EXTENDS]->(p:CodeObject)
       RETURN p`
    );
    
    for (const parent of parentClasses) {
      const inherited = await this.findMethodInClass(methodName, parent.p.name, parent.p.file);
      if (inherited.length > 0) return inherited;
    }
    
    return [];
  }

  /**
   * Pick the best candidate when multiple matches exist
   */
  private pickBestCandidate(candidates: CodeNode[], pending: PendingEdge): CodeNode {
    // Prefer same file
    const sourceFile = this.getFileFromNodeId(pending.sourceId);
    const sameFile = candidates.find(c => c.file === sourceFile);
    if (sameFile) return sameFile;
    
    // Prefer imported symbols
    if (pending.importSource) {
      const imported = candidates.find(c => c.file === pending.importSource);
      if (imported) return imported;
    }
    
    // Default to first candidate
    return candidates[0];
  }

  /**
   * Resolve import path to absolute path
   */
  private resolveImportPath(importPath: string, fromFile: string): string {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const dir = path.dirname(fromFile);
      const resolved = path.resolve(dir, importPath);
      
      // Add common extensions if not present
      if (!path.extname(resolved)) {
        const extensions = ['.ts', '.tsx', '.js', '.jsx'];
        for (const ext of extensions) {
          const withExt = resolved + ext;
          // In real implementation, check if file exists
          return withExt;
        }
      }
      
      return resolved;
    }
    
    // For node_modules or absolute imports, return as-is
    return importPath;
  }

  /**
   * Extract file path from node ID
   */
  private getFileFromNodeId(nodeId: string): string {
    // Node ID format: "file/path:type:name:line"
    const parts = nodeId.split(':');
    return parts[0];
  }

  /**
   * Determine resolution type for statistics
   */
  private getResolutionType(pending: PendingEdge, resolved: CodeNode): string {
    const sourceFile = this.getFileFromNodeId(pending.sourceId);
    
    if (resolved.file === sourceFile) {
      return 'same_file';
    } else if (pending.importSource === resolved.file) {
      return 'imported';
    } else if (pending.receiver) {
      return 'method_call';
    } else {
      return 'global';
    }
  }

  /**
   * Get resolution statistics
   */
  getStats(): ResolutionStats {
    return { ...this.stats };
  }
}