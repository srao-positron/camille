/**
 * Unified search across vector and graph databases
 */

import { logger } from '../../logger.js';
import { ConfigManager } from '../../config.js';
import { OpenAIClient } from '../../openai-client.js';
import { VectorDB, SearchResult as VectorSearchResult } from '../databases/vector-db.js';
import { GraphDB, GraphQueryResult, CodeNode } from '../databases/graph-db.js';
import { LanceVectorDB } from '../databases/lance-db.js';
import { KuzuGraphDB } from '../databases/kuzu-db.js';

export interface SearchOptions {
  limit?: number;
  includeGraph?: boolean;
  includeVector?: boolean;
  projectFilter?: string;
  timeRange?: 'today' | 'week' | 'month' | 'all';
  scoreThreshold?: number;
}

export interface UnifiedSearchResult {
  conversations: ConversationResult[];
  codeElements: CodeElementResult[];
  relevanceScore: number;
  searchTime: number;
}

export interface ConversationResult {
  content: string;
  sessionId: string;
  projectPath?: string;
  timestamp: string;
  score: number;
  topics?: string[];
  context?: string;
  chunkId?: string;
  transcriptPath?: string;
  messageRange?: {
    start: number;
    end: number;
  };
  navigation?: {
    previousChunkId?: string;
    nextChunkId?: string;
    totalChunks?: number;
    chunkIndex?: number;
  };
}

export interface CodeElementResult {
  node: CodeNode;
  relationships: Array<{
    type: string;
    target: CodeNode;
  }>;
  relevanceScore: number;
}

export class UnifiedSearch {
  private vectorDB: VectorDB;
  private graphDB: GraphDB;
  private openAI: OpenAIClient;
  private config: ConfigManager;

  constructor() {
    this.config = new ConfigManager();
    const apiKey = this.config.getOpenAIApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }
    this.openAI = new OpenAIClient(apiKey, this.config.getConfig(), process.cwd());
    this.vectorDB = new LanceVectorDB('transcripts');
    this.graphDB = new KuzuGraphDB();
  }

  /**
   * Perform unified search across all memory sources
   */
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<UnifiedSearchResult> {
    const startTime = Date.now();
    const {
      limit = 10,
      includeGraph = true,
      includeVector = true,
      projectFilter,
      timeRange,
      scoreThreshold = 0.7
    } = options;

    try {
      const results: UnifiedSearchResult = {
        conversations: [],
        codeElements: [],
        relevanceScore: 0,
        searchTime: 0
      };

      // Parallel search across databases
      const searches: Promise<any>[] = [];

      if (includeVector) {
        searches.push(this.searchConversations(query, {
          limit,
          projectFilter,
          timeRange,
          scoreThreshold
        }));
      }

      if (includeGraph) {
        searches.push(this.searchCodeElements(query, {
          limit,
          scoreThreshold
        }));
      }

      const [conversationResults, codeResults] = await Promise.all(searches);

      if (conversationResults) {
        results.conversations = conversationResults;
      }

      if (codeResults) {
        results.codeElements = codeResults;
      }

      // Calculate overall relevance score
      results.relevanceScore = this.calculateRelevanceScore(results);
      results.searchTime = Date.now() - startTime;

      logger.info('Unified search completed', {
        query,
        conversationCount: results.conversations.length,
        codeElementCount: results.codeElements.length,
        searchTime: results.searchTime
      });

      return results;
    } catch (error) {
      logger.error('Unified search failed', { error, query });
      throw error;
    }
  }

  /**
   * Search conversation history
   */
  private async searchConversations(
    query: string,
    options: {
      limit: number;
      projectFilter?: string;
      timeRange?: string;
      scoreThreshold: number;
    }
  ): Promise<ConversationResult[]> {
    await this.vectorDB.connect();

    try {
      // Generate embedding for query
      const queryEmbedding = await this.openAI.generateEmbedding(query);

      // Build filter based on options
      const filter: Record<string, any> = {};
      if (options.projectFilter) {
        filter.projectPath = options.projectFilter;
      }
      if (options.timeRange && options.timeRange !== 'all') {
        filter.startTime = this.getTimeRangeFilter(options.timeRange);
      }

      // Search vector database
      const results = await this.vectorDB.search(
        queryEmbedding,
        options.limit * 2, // Get more results for filtering
        filter
      );

      // Filter by score threshold and format results
      const conversations: ConversationResult[] = results
        .filter(r => r.score >= options.scoreThreshold)
        .slice(0, options.limit)
        .map(r => ({
          content: r.content || '',
          sessionId: r.metadata.sessionId,
          projectPath: r.metadata.projectPath,
          timestamp: r.metadata.startTime,
          score: r.score,
          topics: r.metadata.topics,
          context: this.extractContext(r.content || '', query),
          chunkId: r.metadata.chunkId || `${r.metadata.sessionId}-chunk-${r.metadata.chunkIndex || 'unknown'}`,
          messageRange: r.metadata.messageRange,
          navigation: r.metadata.navigation
        }));

      return conversations;
    } finally {
      await this.vectorDB.close();
    }
  }

  /**
   * Search code elements in graph
   */
  private async searchCodeElements(
    query: string,
    options: {
      limit: number;
      scoreThreshold: number;
    }
  ): Promise<CodeElementResult[]> {
    await this.graphDB.connect();

    try {
      // Parse query to identify code patterns
      const codePatterns = this.extractCodePatterns(query);
      const results: CodeElementResult[] = [];

      // Search by different strategies
      if (codePatterns.functionName) {
        const nodes = await this.graphDB.findNodes('function', codePatterns.functionName);
        for (const node of nodes.slice(0, options.limit)) {
          const relationships = await this.graphDB.getRelationships(node.id);
          results.push({
            node,
            relationships: relationships.edges.map(e => ({
              type: e.relationship,
              target: relationships.nodes.find(n => n.id === e.target)!
            })),
            relevanceScore: this.calculateNodeRelevance(node, query)
          });
        }
      }

      if (codePatterns.className) {
        const nodes = await this.graphDB.findNodes('class', codePatterns.className);
        for (const node of nodes.slice(0, options.limit - results.length)) {
          const relationships = await this.graphDB.getRelationships(node.id);
          results.push({
            node,
            relationships: relationships.edges.map(e => ({
              type: e.relationship,
              target: relationships.nodes.find(n => n.id === e.target)!
            })),
            relevanceScore: this.calculateNodeRelevance(node, query)
          });
        }
      }

      // Filter by relevance score
      return results
        .filter(r => r.relevanceScore >= options.scoreThreshold)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, options.limit);
    } finally {
      await this.graphDB.close();
    }
  }

  /**
   * Extract code patterns from query
   */
  private extractCodePatterns(query: string): {
    functionName?: string;
    className?: string;
    fileName?: string;
  } {
    const patterns: any = {};

    // Function patterns
    const funcMatch = query.match(/(?:function|method|func)\s+(\w+)/i);
    if (funcMatch) {
      patterns.functionName = funcMatch[1];
    }

    // Class patterns
    const classMatch = query.match(/(?:class|interface|type)\s+(\w+)/i);
    if (classMatch) {
      patterns.className = classMatch[1];
    }

    // File patterns
    const fileMatch = query.match(/(?:file|in)\s+([\w./]+\.\w+)/i);
    if (fileMatch) {
      patterns.fileName = fileMatch[1];
    }

    // If no specific patterns, try to extract identifiers
    if (!patterns.functionName && !patterns.className) {
      const identifiers = query.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
      if (identifiers && identifiers.length > 0) {
        patterns.className = identifiers[0];
      }
    }

    return patterns;
  }

  /**
   * Calculate relevance score for a code node
   */
  private calculateNodeRelevance(node: CodeNode, query: string): number {
    let score = 0.5; // Base score

    const queryLower = query.toLowerCase();
    const nameLower = node.name.toLowerCase();

    // Exact name match
    if (nameLower === queryLower) {
      score = 1.0;
    }
    // Name contains query
    else if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
      score = 0.8;
    }
    // File path relevance
    else if (node.file.toLowerCase().includes(queryLower)) {
      score = 0.7;
    }

    return score;
  }

  /**
   * Extract context around matching content
   */
  private extractContext(content: string, query: string): string {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    
    const index = contentLower.indexOf(queryLower);
    if (index === -1) {
      // If exact match not found, return first 200 chars
      return content.substring(0, 200) + '...';
    }

    // Extract context around match
    const contextRadius = 100;
    const start = Math.max(0, index - contextRadius);
    const end = Math.min(content.length, index + query.length + contextRadius);
    
    let context = content.substring(start, end);
    
    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < content.length) context = context + '...';
    
    return context;
  }

  /**
   * Get time range filter
   */
  private getTimeRangeFilter(timeRange: string): string {
    const now = new Date();
    let cutoff: Date;

    switch (timeRange) {
      case 'today':
        cutoff = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        cutoff = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'month':
        cutoff = new Date(now.setMonth(now.getMonth() - 1));
        break;
      default:
        cutoff = new Date(0); // Beginning of time
    }

    return cutoff.toISOString();
  }

  /**
   * Calculate overall relevance score
   */
  private calculateRelevanceScore(results: UnifiedSearchResult): number {
    const conversationScores = results.conversations.map(c => c.score);
    const codeScores = results.codeElements.map(c => c.relevanceScore);
    const allScores = [...conversationScores, ...codeScores];

    if (allScores.length === 0) return 0;

    // Weighted average with higher weight for top results
    const sortedScores = allScores.sort((a, b) => b - a);
    let weightedSum = 0;
    let weightSum = 0;

    for (let i = 0; i < sortedScores.length; i++) {
      const weight = 1 / (i + 1); // Higher weight for top results
      weightedSum += sortedScores[i] * weight;
      weightSum += weight;
    }

    return weightedSum / weightSum;
  }
}