/**
 * Unified search for code files combining vector and graph search
 */

import { EmbeddingsIndex, SearchResult } from '../embeddings.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';
import { GraphQueryResult, CodeNode } from '../memory/databases/graph-db.js';
import { ConfigManager } from '../config.js';
import { OpenAIClient } from '../openai-client.js';
import { logger } from '../logger.js';

export interface CodeSearchOptions {
  limit?: number;
  includeGraph?: boolean;
  includeVector?: boolean;
  includeDependencies?: boolean;
  searchMode?: 'vector' | 'graph' | 'unified';
}

export interface DependencyInfo {
  imports: string[];
  calls: Array<{
    function: string;
    location: string;
  }>;
  usedBy: Array<{
    file: string;
    function: string;
  }>;
  classes?: Array<{
    name: string;
    line: number;
    extends?: string[];
    implements?: string[];
  }>;
  functions?: Array<{
    name: string;
    line: number;
    calls: string[];
  }>;
}

export interface EnhancedSearchResult extends SearchResult {
  dependencies?: DependencyInfo;
  graphMatches?: Array<{
    node: CodeNode;
    relationships: GraphQueryResult;
  }>;
}

export class CodeUnifiedSearch {
  private embeddingsIndex: EmbeddingsIndex;
  private graphDB: KuzuGraphDB;
  private openaiClient: OpenAIClient;
  private configManager: ConfigManager;

  constructor(embeddingsIndex: EmbeddingsIndex, graphDB: KuzuGraphDB, openaiClient: OpenAIClient) {
    this.embeddingsIndex = embeddingsIndex;
    this.graphDB = graphDB;
    this.openaiClient = openaiClient;
    this.configManager = new ConfigManager();
  }

  /**
   * Unified search across vector embeddings and graph database
   */
  async search(query: string, options: CodeSearchOptions = {}): Promise<EnhancedSearchResult[]> {
    const {
      limit = 10,
      includeGraph = true,
      includeVector = true,
      includeDependencies = true,
      searchMode = 'unified'
    } = options;

    try {
      let results: EnhancedSearchResult[] = [];

      if (searchMode === 'vector' || searchMode === 'unified') {
        // Vector search using embeddings
        if (includeVector) {
          results = await this.performVectorSearch(query, limit);
        }
      }

      if (searchMode === 'graph' || searchMode === 'unified') {
        // Graph search for code structure
        if (includeGraph) {
          const graphResults = await this.performGraphSearch(query, limit);
          
          if (searchMode === 'graph') {
            results = graphResults;
          } else {
            // Merge with vector results
            results = this.mergeResults(results, graphResults, limit);
          }
        }
      }

      // Enhance results with dependency information
      if (includeDependencies) {
        results = await this.enhanceWithDependencies(results);
      }

      return results.slice(0, limit);
    } catch (error) {
      logger.error('Unified search failed', { query, error });
      // Fallback to vector search only
      return this.performVectorSearch(query, limit);
    }
  }

  /**
   * Perform vector search using embeddings
   */
  private async performVectorSearch(query: string, limit: number): Promise<EnhancedSearchResult[]> {
    const queryEmbedding = await this.openaiClient.generateEmbedding(query);
    const vectorResults = this.embeddingsIndex.search(queryEmbedding, limit, query);
    
    return vectorResults.map(result => ({
      ...result,
      dependencies: undefined,
      graphMatches: undefined
    }));
  }

  /**
   * Perform graph search for code structure
   */
  private async performGraphSearch(query: string, limit: number): Promise<EnhancedSearchResult[]> {
    const results: EnhancedSearchResult[] = [];

    try {
      // Search for nodes by name patterns
      const queryTerms = query.toLowerCase().split(/\s+/);
      
      for (const term of queryTerms) {
        // Find functions matching the term
        const functionNodes = await this.graphDB.findNodes('function', `*${term}*`);
        for (const node of functionNodes.slice(0, Math.ceil(limit / 2))) {
          const relationships = await this.graphDB.getRelationships(node.id);
          
          // Try to get the file content for this node
          const fileContent = this.getFileContentFromEmbeddings(node.file);
          if (fileContent) {
            results.push({
              path: node.file,
              similarity: 0.8, // Default similarity for graph matches
              content: fileContent.content,
              summary: fileContent.summary || `Contains ${node.type}: ${node.name}`,
              lineMatches: [{
                lineNumber: node.line,
                line: `${node.type} ${node.name}`,
                snippet: this.createSnippetForNode(node, fileContent.content)
              }],
              graphMatches: [{
                node,
                relationships
              }]
            });
          }
        }

        // Find classes matching the term
        const classNodes = await this.graphDB.findNodes('class', `*${term}*`);
        for (const node of classNodes.slice(0, Math.ceil(limit / 2))) {
          const relationships = await this.graphDB.getRelationships(node.id);
          
          const fileContent = this.getFileContentFromEmbeddings(node.file);
          if (fileContent) {
            results.push({
              path: node.file,
              similarity: 0.8,
              content: fileContent.content,
              summary: fileContent.summary || `Contains ${node.type}: ${node.name}`,
              lineMatches: [{
                lineNumber: node.line,
                line: `${node.type} ${node.name}`,
                snippet: this.createSnippetForNode(node, fileContent.content)
              }],
              graphMatches: [{
                node,
                relationships
              }]
            });
          }
        }
      }

      return results;
    } catch (error) {
      logger.error('Graph search failed', { query, error });
      return [];
    }
  }

  /**
   * Merge vector and graph search results, removing duplicates
   */
  private mergeResults(
    vectorResults: EnhancedSearchResult[], 
    graphResults: EnhancedSearchResult[], 
    limit: number
  ): EnhancedSearchResult[] {
    const merged = [...vectorResults];
    const seenPaths = new Set(vectorResults.map(r => r.path));

    for (const graphResult of graphResults) {
      if (!seenPaths.has(graphResult.path)) {
        merged.push(graphResult);
        seenPaths.add(graphResult.path);
      } else {
        // Enhance existing result with graph information
        const existing = merged.find(r => r.path === graphResult.path);
        if (existing && graphResult.graphMatches) {
          existing.graphMatches = [...(existing.graphMatches || []), ...graphResult.graphMatches];
        }
      }
    }

    // Sort by similarity score
    return merged.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  /**
   * Enhance results with dependency information from graph database
   */
  private async enhanceWithDependencies(results: EnhancedSearchResult[]): Promise<EnhancedSearchResult[]> {
    for (const result of results) {
      try {
        const dependencies = await this.extractDependencies(result.path);
        result.dependencies = dependencies;
      } catch (error) {
        logger.error('Failed to extract dependencies', { path: result.path, error });
      }
    }
    return results;
  }

  /**
   * Extract dependency information for a file
   */
  private async extractDependencies(filePath: string): Promise<DependencyInfo> {
    const dependencies: DependencyInfo = {
      imports: [],
      calls: [],
      usedBy: []
    };

    try {
      // Find all nodes in this file
      const fileNodes = await this.graphDB.findNodes(undefined, undefined); // This needs a better query
      const nodesInFile = fileNodes.filter((node: CodeNode) => node.file === filePath);

      for (const node of nodesInFile) {
        const relationships = await this.graphDB.getRelationships(node.id, 'out');
        
        for (const edge of relationships.edges) {
          switch (edge.relationship) {
            case 'imports':
              const targetNode = relationships.nodes.find((n: CodeNode) => n.id === edge.target);
              if (targetNode) {
                dependencies.imports.push(targetNode.name);
              }
              break;
            case 'calls':
              const calledNode = relationships.nodes.find((n: CodeNode) => n.id === edge.target);
              if (calledNode) {
                dependencies.calls.push({
                  function: calledNode.name,
                  location: `${calledNode.file}:${calledNode.line}`
                });
              }
              break;
          }
        }

        // Find what uses this node
        const incomingRels = await this.graphDB.getRelationships(node.id, 'in');
        for (const edge of incomingRels.edges) {
          if (edge.relationship === 'calls') {
            const callerNode = incomingRels.nodes.find((n: CodeNode) => n.id === edge.source);
            if (callerNode && callerNode.file !== filePath) {
              dependencies.usedBy.push({
                file: callerNode.file,
                function: callerNode.name
              });
            }
          }
        }
      }

      return dependencies;
    } catch (error) {
      logger.error('Failed to extract dependencies from graph', { filePath, error });
      return dependencies;
    }
  }

  /**
   * Get file content from embeddings index
   */
  private getFileContentFromEmbeddings(filePath: string): { content: string; summary?: string } | null {
    // This would need to be implemented based on the EmbeddingsIndex API
    // For now, return null and rely on vector search results
    return null;
  }

  /**
   * Create a code snippet around a node
   */
  private createSnippetForNode(node: CodeNode, content: string): string {
    const lines = content.split('\n');
    const startLine = Math.max(0, node.line - 3);
    const endLine = Math.min(lines.length, node.line + 2);
    
    return lines
      .slice(startLine, endLine)
      .map((line, index) => {
        const lineNum = startLine + index + 1;
        const marker = lineNum === node.line ? '>' : ' ';
        return `${marker} ${lineNum.toString().padStart(4)}: ${line}`;
      })
      .join('\n');
  }
}