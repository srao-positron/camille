/**
 * Unified search for code files combining vector and graph search
 */

import { EmbeddingsIndex, SearchResult } from '../embeddings.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';
import { GraphQueryResult, CodeNode } from '../memory/databases/graph-db.js';
import { ConfigManager } from '../config.js';
import { OpenAIClient } from '../openai-client.js';
import { logger } from '../logger.js';
import { SupastateStorageProvider } from '../storage/supastate-provider.js';

export interface CodeSearchOptions {
  limit?: number;
  includeDependencies?: boolean;
  directory?: string;
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
  private openaiClient?: OpenAIClient;
  private configManager: ConfigManager;
  private supastateProvider?: SupastateStorageProvider;

  constructor(embeddingsIndex: EmbeddingsIndex, graphDB: KuzuGraphDB, openaiClient?: OpenAIClient) {
    this.embeddingsIndex = embeddingsIndex;
    this.graphDB = graphDB;
    this.openaiClient = openaiClient;
    this.configManager = new ConfigManager();
    
    // Check if Supastate is enabled
    const config = this.configManager.getConfig();
    if (config.supastate?.enabled) {
      try {
        this.supastateProvider = new SupastateStorageProvider();
        logger.info('CodeUnifiedSearch using Supastate for search');
      } catch (error) {
        logger.error('Failed to initialize SupastateStorageProvider:', error);
      }
    }
  }

  /**
   * Unified search across vector embeddings and graph database
   */
  async search(query: string, options: CodeSearchOptions = {}): Promise<EnhancedSearchResult[]> {
    const {
      limit = 10,
      includeDependencies = true,
      directory
    } = options;

    logger.info('🔍 UnifiedSearch.search START', { 
      query, 
      directory,
      limit 
    });

    try {
      // Perform vector search using embeddings
      logger.info('📊 Starting vector search', { query, limit });
      let results = await this.performVectorSearch(query, limit);
      logger.info('📊 Vector search complete', { resultCount: results.length });

      // Apply directory filter to all results
      if (directory) {
        results = results.filter(result => 
          result.path.toLowerCase().includes(directory.toLowerCase())
        );
      }

      // Enhance results with dependency information
      if (includeDependencies) {
        results = await this.enhanceWithDependencies(results);
      }

      logger.info('🔍 UnifiedSearch.search END', { 
        query,
        finalResultCount: results.length,
        limitApplied: limit
      });
      return results.slice(0, limit);
    } catch (error) {
      logger.error('❌ Unified search failed', { query, error });
      // Fallback to vector search only
      return this.performVectorSearch(query, limit);
    }
  }

  /**
   * Perform vector search using embeddings
   */
  private async performVectorSearch(query: string, limit: number): Promise<EnhancedSearchResult[]> {
    // If using Supastate, use their search API
    if (this.supastateProvider) {
      const results = await this.supastateProvider.searchCode(query, limit);
      return results.map((result: any) => ({
        path: result.metadata?.path || '',
        similarity: result.score,
        content: result.content,
        summary: result.metadata?.summary || '',
        lineMatches: [],
        dependencies: undefined,
        graphMatches: undefined
      }));
    }
    
    // Original local search
    if (!this.openaiClient) {
      logger.warn('No OpenAI client available for vector search');
      return [];
    }
    
    const queryEmbedding = await this.openaiClient.generateEmbedding(query);
    const vectorResults = this.embeddingsIndex.search(queryEmbedding, limit, query);
    
    return vectorResults.map(result => ({
      ...result,
      dependencies: undefined,
      graphMatches: undefined
    }));
  }

  /**
   * Convert natural language query to Cypher using OpenAI
   */
  private async text2Cypher(query: string, directory?: string): Promise<string> {
    logger.info('🧠 text2Cypher START', { query, directory });
    
    try {
      // Get the graph schema
      const schema = await this.graphDB.getSchema();
      logger.info('📜 Got graph schema', { schemaLength: schema.length });
      
      const directoryClause = directory ? ` AND n.file =~ '.*${directory}.*'` : '';
      
      const prompt = `You are an expert at converting natural language queries to Cypher queries for a code graph database.

Given the following schema:
${schema}

Convert this natural language query to a Cypher query:
"${query}"${directory ? `\nLimit results to files in directory: ${directory}` : ''}

Important guidelines:
1. Use MATCH patterns to find nodes and relationships
2. Use WHERE clauses for filtering
3. Return relevant nodes with their properties
4. Include relationship patterns when the query asks about dependencies, calls, imports, etc.
5. Limit results to 10 unless specified otherwise
6. For function calls, use the CALLS relationship
7. For inheritance, use EXTENDS or IMPLEMENTS relationships
8. For imports, use the IMPORTS relationship
${directory ? `9. Add WHERE clause to filter by directory: WHERE n.file =~ '.*${directory}.*'` : ''}

Examples:
- "functions that call escapeForCypher" -> MATCH (n:CodeObject)-[:CALLS]->(m:CodeObject {name: 'escapeForCypher'}) WHERE n.type = 'function'${directoryClause} RETURN n LIMIT 10
- "classes that extend BaseClass" -> MATCH (n:CodeObject {type: 'class'})-[:EXTENDS]->(m:CodeObject {name: 'BaseClass'})${directoryClause ? ' WHERE n.file =~ \'.*' + directory + '.*\'' : ''} RETURN n LIMIT 10
- "all functions in server.ts" -> MATCH (n:CodeObject {type: 'function'}) WHERE n.file =~ '.*server.ts$'${directoryClause} RETURN n LIMIT 10

Return ONLY the Cypher query, no explanation.`;

      logger.info('🤖 Calling OpenAI for Text2Cypher', { model: 'gpt-4o-mini', promptLength: prompt.length });
      
      // Use GPT-4o-mini for Text2Cypher conversion
      if (!this.openaiClient) {
        logger.warn('No OpenAI client available for Text2Cypher');
        // Fallback to basic pattern matching
        const directoryFilter = directory ? ` AND n.file =~ '.*${directory}.*'` : '';
        return `MATCH (n:CodeObject) WHERE n.name =~ '.*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*'${directoryFilter} RETURN n LIMIT 10`;
      }
      
      const response = await this.openaiClient.complete(prompt, 'gpt-4o-mini');
      
      // Strip markdown code blocks if present
      let cypherQuery = response.trim();
      if (cypherQuery.startsWith('```')) {
        // Remove opening code block
        cypherQuery = cypherQuery.replace(/^```(?:cypher|sql)?\n?/, '');
        // Remove closing code block
        cypherQuery = cypherQuery.replace(/\n?```$/, '');
        cypherQuery = cypherQuery.trim();
      }
      
      logger.info('✅ text2Cypher SUCCESS', { 
        originalQuery: query,
        generatedCypher: cypherQuery,
        directory 
      });
      
      return cypherQuery;
    } catch (error) {
      logger.error('❌ text2Cypher FAILED', { error, query });
      // Fallback to basic pattern matching with directory filter
      const directoryFilter = directory ? ` AND n.file =~ '.*${directory}.*'` : '';
      return `MATCH (n:CodeObject) WHERE n.name =~ '.*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*'${directoryFilter} RETURN n LIMIT 10`;
    }
  }

  /**
   * Perform graph search for code structure
   */
  private async performGraphSearch(query: string, limit: number, directory?: string): Promise<EnhancedSearchResult[]> {
    logger.info('🔗 performGraphSearch START', { query, limit, directory });
    const results: EnhancedSearchResult[] = [];

    try {
      // Convert natural language to Cypher
      const cypherQuery = await this.text2Cypher(query, directory);
      logger.info('🔍 Executing Cypher query', { cypherQuery });
      
      // Execute the Cypher query
      const queryResults = await this.graphDB.query(cypherQuery);
      logger.info('📊 Cypher query results', { 
        resultCount: queryResults.length,
        firstResult: queryResults[0] || 'none'
      });
      
      // Process results
      logger.info('📦 Processing query results', { 
        rawResultCount: queryResults.length,
        firstRawResult: queryResults[0] ? JSON.stringify(queryResults[0]).substring(0, 200) : 'none'
      });
      
      // Process all nodes at once without individual relationship queries
      for (const result of queryResults.slice(0, limit)) {
        const node = result.n || result; // Handle different result formats
        
        logger.debug('🔍 Processing node', { 
          hasNode: !!node,
          nodeId: node?.id,
          nodeFile: node?.file,
          nodeName: node?.name,
          nodeType: node?.type
        });
        
        if (node && node.id) {
          // Try to get the file content for this node
          const fileContent = this.getFileContentFromEmbeddings(node.file);
          logger.debug('📄 File content check', { 
            file: node.file,
            hasContent: !!fileContent 
          });
          
          // Create result without fetching relationships for each node
          // This avoids the N+1 query problem
          results.push({
            path: node.file,
            similarity: 0.8,
            content: fileContent?.content || `// ${node.type} ${node.name} at line ${node.line}`,
            summary: fileContent?.summary || `Contains ${node.type}: ${node.name}`,
            lineMatches: [{
              lineNumber: node.line,
              line: `${node.type} ${node.name}`,
              snippet: fileContent ? this.createSnippetForNode(node, fileContent.content) : `${node.type} ${node.name}`
            }],
            graphMatches: [{
              node,
              relationships: { edges: [], nodes: [] } // Empty relationships to avoid fetching
            }]
          });
          
          logger.debug('✅ Added result', { 
            path: node.file,
            resultCount: results.length 
          });
        }
      }

      logger.info('🔗 performGraphSearch END', { 
        query,
        resultCount: results.length 
      });
      return results;
    } catch (error) {
      logger.error('❌ performGraphSearch FAILED', { 
        query, 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n')
        } : error 
      });
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
      // Query nodes directly from this file using Cypher
      const fileQuery = `MATCH (n:CodeObject) WHERE n.file = '${filePath.replace(/'/g, "''")}' RETURN n`;
      const fileResults = await this.graphDB.query(fileQuery);
      const nodesInFile = fileResults.map((result: any) => result.n).filter(Boolean);

      // Get all relationships for nodes in this file with a single query
      if (nodesInFile.length > 0) {
        // Query outgoing relationships (imports and calls)
        const nodeIds = nodesInFile.map((n: any) => `'${n.id}'`).join(', ');
        const outQuery = `MATCH (n:CodeObject)-[r]->(m:CodeObject) WHERE n.id IN [${nodeIds}] RETURN n, r, m`;
        const outResults = await this.graphDB.query(outQuery);
        
        for (const result of outResults) {
          const edge = result.r;
          const targetNode = result.m;
          
          switch (edge.label) {
            case 'imports':
              if (targetNode) {
                dependencies.imports.push(targetNode.name);
              }
              break;
            case 'calls':
              if (targetNode) {
                dependencies.calls.push({
                  function: targetNode.name,
                  location: `${targetNode.file}:${targetNode.line}`
                });
              }
              break;
          }
        }
        
        // Query incoming relationships (who calls us) - only from other files
        const inQuery = `MATCH (m:CodeObject)-[r:calls]->(n:CodeObject) WHERE n.id IN [${nodeIds}] AND m.file <> '${filePath.replace(/'/g, "''")}' RETURN m`;
        const inResults = await this.graphDB.query(inQuery);
        
        for (const result of inResults) {
          const callerNode = result.m;
          if (callerNode) {
            dependencies.usedBy.push({
              file: callerNode.file,
              function: callerNode.name
            });
          }
        }
      }

      return dependencies;
    } catch (error) {
      logger.error('Failed to extract dependencies from graph', { 
        filePath, 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error 
      });
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