# MCP Tools Design Document

## Overview

The MCP tools provide Claude Code with intelligent access to the memory system, enabling semantic search across conversation history and code, with automatic discovery mechanisms to encourage usage.

## Tool Architecture

### Tool Registry

```typescript
interface MemoryTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: any) => Promise<any>;
  aliases?: string[];
  contextTriggers?: RegExp[];
}

const MEMORY_TOOLS: MemoryTool[] = [
  {
    name: 'recall_previous_discussions',
    aliases: ['search_memory', 'find_past_conversations'],
    description: `Search through our entire conversation history across all projects. 
                  I can help you remember solutions we've discussed, code patterns 
                  we've implemented, and decisions we've made together. This includes 
                  conversations from other projects and previous sessions.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to remember or find'
        },
        type: {
          type: 'string',
          enum: ['all', 'conversation', 'code', 'decision'],
          description: 'Type of memory to search',
          default: 'all'
        },
        project_filter: {
          type: 'string',
          description: 'Limit to specific project path',
          optional: true
        },
        time_range: {
          type: 'string',
          enum: ['today', 'week', 'month', 'all'],
          description: 'Time range to search',
          default: 'all'
        },
        include_peers: {
          type: 'boolean',
          description: 'Include results from team members',
          default: false
        }
      },
      required: ['query']
    },
    contextTriggers: [
      /how did we/i,
      /remember when/i,
      /last time/i,
      /previously/i,
      /before we/i,
      /earlier you/i,
      /in our last/i,
      /we discussed/i
    ],
    handler: recallDiscussionsHandler
  },
  {
    name: 'find_similar_problems',
    description: `Find conversations where we solved similar problems or worked on 
                  similar features. Great for finding patterns and reusable solutions.`,
    inputSchema: {
      type: 'object',
      properties: {
        problem_description: {
          type: 'string',
          description: 'Describe the problem or feature'
        },
        code_context: {
          type: 'string',
          description: 'Optional code snippet for context',
          optional: true
        }
      },
      required: ['problem_description']
    },
    handler: findSimilarProblemsHandler
  },
  {
    name: 'search_code_history',
    description: `Search through all code we've worked on together, including 
                  examples, implementations, and modifications across all projects.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Code pattern, function name, or concept'
        },
        language: {
          type: 'string',
          description: 'Programming language filter',
          optional: true
        },
        include_context: {
          type: 'boolean',
          description: 'Include surrounding conversation',
          default: true
        }
      },
      required: ['query']
    },
    handler: searchCodeHistoryHandler
  },
  {
    name: 'unified_memory_search',
    description: `Intelligently search across all memory types - conversations, 
                  code, decisions, and graph relationships. I'll figure out the 
                  best search strategy based on your query.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query'
        },
        options: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 10 },
            merge_results: { type: 'boolean', default: true },
            include_graph: { type: 'boolean', default: true }
          }
        }
      },
      required: ['query']
    },
    handler: unifiedSearchHandler
  }
];
```

## Search Handlers Implementation

### Recall Previous Discussions

```typescript
async function recallDiscussionsHandler(args: {
  query: string;
  type?: string;
  project_filter?: string;
  time_range?: string;
  include_peers?: boolean;
}): Promise<MemorySearchResult> {
  const startTime = Date.now();
  
  try {
    // Generate embedding for the query
    const queryEmbedding = await embeddingGenerator.generate(args.query);
    
    // Build search filters
    const filters = buildFilters(args);
    
    // Search local memory
    const localResults = await searchLocalMemory(queryEmbedding, filters);
    
    // Search peer memories if requested
    let peerResults: SearchResult[] = [];
    if (args.include_peers) {
      peerResults = await searchPeerMemories(args.query, filters);
    }
    
    // Format results with context
    const formattedResults = await formatMemoryResults(
      localResults,
      peerResults,
      args.query
    );
    
    // Log search for analytics
    await logSearch({
      tool: 'recall_previous_discussions',
      query: args.query,
      filters: args,
      resultCount: formattedResults.results.length,
      duration: Date.now() - startTime
    });
    
    return formattedResults;
    
  } catch (error) {
    logger.error('Memory search failed', { error, args });
    
    // Fallback to keyword search if embedding fails
    return fallbackKeywordSearch(args.query, filters);
  }
}

function buildFilters(args: any): SearchFilters {
  const filters: SearchFilters = {};
  
  // Time range filter
  if (args.time_range && args.time_range !== 'all') {
    const now = new Date();
    switch (args.time_range) {
      case 'today':
        filters.after = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        filters.after = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'month':
        filters.after = new Date(now.setMonth(now.getMonth() - 1));
        break;
    }
  }
  
  // Project filter
  if (args.project_filter) {
    filters.project = args.project_filter;
  }
  
  // Type filter
  if (args.type && args.type !== 'all') {
    filters.contentType = args.type;
  }
  
  return filters;
}
```

### Memory Result Formatting

```typescript
interface MemorySearchResult {
  results: MemoryResult[];
  summary: string;
  stats: {
    total_results: number;
    sources: { [key: string]: number };
    time_range: { oldest: Date; newest: Date };
  };
}

interface MemoryResult {
  id: string;
  type: 'conversation' | 'code' | 'decision';
  content: string;
  context: {
    session_id: string;
    project_path: string;
    timestamp: Date;
    participants: string[];
    before?: string;  // Previous message
    after?: string;   // Next message
  };
  relevance_score: number;
  source: string;  // 'local' or peer name
  highlights: string[];  // Key phrases highlighted
}

async function formatMemoryResults(
  local: SearchResult[],
  peer: SearchResult[],
  query: string
): Promise<MemorySearchResult> {
  const results: MemoryResult[] = [];
  
  // Process and enrich results
  for (const result of [...local, ...peer]) {
    const enriched = await enrichResult(result, query);
    results.push(enriched);
  }
  
  // Sort by relevance and recency
  results.sort((a, b) => {
    // Primary sort by relevance
    if (Math.abs(a.relevance_score - b.relevance_score) > 0.1) {
      return b.relevance_score - a.relevance_score;
    }
    // Secondary sort by recency
    return b.context.timestamp.getTime() - a.context.timestamp.getTime();
  });
  
  // Generate summary
  const summary = generateSearchSummary(results, query);
  
  // Calculate statistics
  const stats = calculateSearchStats(results);
  
  return {
    results: results.slice(0, 50),  // Limit results
    summary,
    stats
  };
}

function generateSearchSummary(results: MemoryResult[], query: string): string {
  if (results.length === 0) {
    return `I couldn't find any previous discussions about "${query}". This might be a new topic we haven't explored together yet.`;
  }
  
  const topics = extractTopics(results);
  const projects = [...new Set(results.map(r => r.context.project_path))];
  const timeRange = getTimeRange(results);
  
  let summary = `I found ${results.length} relevant discussions about "${query}"`;
  
  if (topics.length > 0) {
    summary += ` covering ${topics.slice(0, 3).join(', ')}`;
  }
  
  if (projects.length > 1) {
    summary += ` across ${projects.length} projects`;
  }
  
  if (timeRange.days > 30) {
    summary += ` spanning ${Math.round(timeRange.days / 30)} months`;
  }
  
  summary += '.';
  
  // Add actionable insight
  if (results[0].relevance_score > 0.9) {
    summary += ` The most relevant discussion was ${timeAgo(results[0].context.timestamp)} where we ${extractAction(results[0])}.`;
  }
  
  return summary;
}
```

## Contextual Discovery System

### Automatic Context Injection

```typescript
class ContextualMemoryInjector {
  private readonly triggers = [
    {
      pattern: /how did we (.*?) before/i,
      handler: this.injectPreviousImplementation
    },
    {
      pattern: /remember when we (.*?)\?/i,
      handler: this.injectMemoryContext  
    },
    {
      pattern: /last time we worked on (.*?)/i,
      handler: this.injectLastWorkContext
    },
    {
      pattern: /what was that (.*?) we discussed/i,
      handler: this.injectDiscussionContext
    }
  ];
  
  async processQuery(query: string): Promise<InjectedContext | null> {
    for (const trigger of this.triggers) {
      const match = query.match(trigger.pattern);
      if (match) {
        return trigger.handler(query, match);
      }
    }
    
    // Check for implicit memory needs
    if (this.needsMemoryContext(query)) {
      return this.injectRelevantMemory(query);
    }
    
    return null;
  }
  
  private needsMemoryContext(query: string): boolean {
    const memoryIndicators = [
      'again',
      'similar to',
      'like before',
      'the same way',
      'remember',
      'recall',
      'previously',
      'earlier'
    ];
    
    const lowerQuery = query.toLowerCase();
    return memoryIndicators.some(indicator => 
      lowerQuery.includes(indicator)
    );
  }
  
  private async injectPreviousImplementation(
    query: string,
    match: RegExpMatchArray
  ): Promise<InjectedContext> {
    const topic = match[1];
    
    // Search for previous implementations
    const results = await searchLocalMemory(
      await embeddingGenerator.generate(`implementation of ${topic}`),
      { type: 'code' }
    );
    
    if (results.length > 0) {
      return {
        type: 'previous_implementation',
        content: `I found ${results.length} previous implementations of ${topic}. Here's the most relevant one:\n\n${results[0].content}`,
        confidence: results[0].score,
        source: results[0].metadata
      };
    }
    
    return null;
  }
}
```

### Proactive Memory Suggestions

```typescript
class ProactiveMemoryAssistant {
  private recentQueries: string[] = [];
  private sessionContext: Map<string, any> = new Map();
  
  async suggestMemorySearch(
    currentInput: string,
    sessionHistory: Message[]
  ): Promise<MemorySuggestion | null> {
    // Analyze current context
    const context = this.analyzeContext(currentInput, sessionHistory);
    
    // Check if memory would be helpful
    if (this.shouldSuggestMemory(context)) {
      const suggestion = await this.generateSuggestion(context);
      return suggestion;
    }
    
    return null;
  }
  
  private shouldSuggestMemory(context: Context): boolean {
    // Suggest memory if:
    // 1. Working on similar problem to before
    if (context.similarity_to_past > 0.7) return true;
    
    // 2. Asking about implementation details
    if (context.asking_how_to && context.complexity > 0.5) return true;
    
    // 3. Debugging issue that might have been solved
    if (context.debugging && context.error_similarity > 0.6) return true;
    
    // 4. Starting new feature that relates to past work
    if (context.new_feature && context.domain_overlap > 0.5) return true;
    
    return false;
  }
  
  private async generateSuggestion(context: Context): Promise<MemorySuggestion> {
    const queryTerms = this.extractQueryTerms(context);
    
    // Pre-search to check if we have relevant memory
    const previewResults = await this.previewSearch(queryTerms);
    
    if (previewResults.count > 0) {
      return {
        type: 'memory_available',
        message: this.formatSuggestionMessage(context, previewResults),
        suggestedQuery: queryTerms.join(' '),
        confidence: previewResults.relevance,
        action: {
          tool: 'recall_previous_discussions',
          args: {
            query: queryTerms.join(' '),
            type: context.contentType
          }
        }
      };
    }
    
    return null;
  }
  
  private formatSuggestionMessage(
    context: Context, 
    preview: PreviewResults
  ): string {
    const messages = [
      `I notice this is similar to work we've done before.`,
      `I found ${preview.count} relevant discussions in our history.`,
      `We've tackled similar problems in the past.`,
      `This reminds me of our previous work on ${preview.topics[0]}.`
    ];
    
    // Select appropriate message based on context
    if (context.debugging) {
      return `I found ${preview.count} discussions about similar errors. Would you like me to search our conversation history?`;
    }
    
    if (context.new_feature) {
      return `We've implemented similar features before. I can search for those discussions if helpful.`;
    }
    
    return messages[Math.floor(Math.random() * messages.length)];
  }
}
```

## Unified Search Intelligence

### Query Intent Analysis

```typescript
interface QueryIntent {
  primary_intent: 'find_code' | 'recall_discussion' | 'trace_dependencies' | 'understand_structure';
  search_types: ('semantic' | 'graph' | 'keyword')[];
  entities: {
    functions?: string[];
    files?: string[];
    concepts?: string[];
    time_references?: string[];
  };
  confidence: number;
}

class QueryAnalyzer {
  async analyzeIntent(query: string): Promise<QueryIntent> {
    const lower = query.toLowerCase();
    
    // Pattern matching for different intents
    const patterns = {
      find_code: [
        /show me the (function|class|implementation)/,
        /where is the (code|logic) for/,
        /find.*implement/
      ],
      recall_discussion: [
        /what did we (decide|discuss)/,
        /remember when/,
        /our conversation about/
      ],
      trace_dependencies: [
        /what (calls|uses|depends on)/,
        /affected by changes to/,
        /dependency graph/
      ],
      understand_structure: [
        /how does .* work/,
        /structure of/,
        /architecture of/
      ]
    };
    
    // Extract entities
    const entities = {
      functions: this.extractFunctionNames(query),
      files: this.extractFileNames(query),
      concepts: this.extractConcepts(query),
      time_references: this.extractTimeReferences(query)
    };
    
    // Determine primary intent
    let primary_intent: QueryIntent['primary_intent'] = 'recall_discussion';
    let confidence = 0.5;
    
    for (const [intent, patterns] of Object.entries(patterns)) {
      for (const pattern of patterns) {
        if (pattern.test(lower)) {
          primary_intent = intent as QueryIntent['primary_intent'];
          confidence = 0.8;
          break;
        }
      }
    }
    
    // Determine search types needed
    const search_types = this.determineSearchTypes(primary_intent, entities);
    
    return {
      primary_intent,
      search_types,
      entities,
      confidence
    };
  }
  
  private determineSearchTypes(
    intent: string,
    entities: any
  ): ('semantic' | 'graph' | 'keyword')[] {
    switch (intent) {
      case 'find_code':
        return ['semantic', 'keyword'];
      case 'trace_dependencies':
        return ['graph', 'semantic'];
      case 'recall_discussion':
        return ['semantic'];
      case 'understand_structure':
        return ['graph', 'semantic'];
      default:
        return ['semantic', 'keyword'];
    }
  }
}
```

### Hybrid Search Execution

```typescript
class HybridSearchExecutor {
  async execute(
    query: string,
    intent: QueryIntent
  ): Promise<UnifiedSearchResult> {
    const searchPromises: Promise<any>[] = [];
    
    // Execute searches based on intent
    if (intent.search_types.includes('semantic')) {
      searchPromises.push(this.semanticSearch(query, intent));
    }
    
    if (intent.search_types.includes('graph')) {
      searchPromises.push(this.graphSearch(query, intent));
    }
    
    if (intent.search_types.includes('keyword')) {
      searchPromises.push(this.keywordSearch(query, intent));
    }
    
    // Execute in parallel
    const results = await Promise.all(searchPromises);
    
    // Merge and rank results
    const merged = await this.mergeResults(results, intent);
    
    // Generate explanation
    const explanation = this.generateExplanation(merged, intent);
    
    return {
      results: merged,
      intent,
      explanation,
      suggestions: this.generateFollowUpSuggestions(merged, intent)
    };
  }
  
  private async semanticSearch(
    query: string,
    intent: QueryIntent
  ): Promise<SearchResult[]> {
    const embedding = await embeddingGenerator.generate(query);
    
    // Search both transcripts and code
    const [transcripts, code] = await Promise.all([
      transcriptIndex.search(embedding, { limit: 20 }),
      codeIndex.search(embedding, { limit: 20 })
    ]);
    
    return [...transcripts, ...code].map(r => ({
      ...r,
      search_type: 'semantic'
    }));
  }
  
  private async graphSearch(
    query: string,
    intent: QueryIntent
  ): Promise<SearchResult[]> {
    // Build Cypher query based on intent
    let cypherQuery: string;
    
    switch (intent.primary_intent) {
      case 'trace_dependencies':
        cypherQuery = this.buildDependencyQuery(intent.entities);
        break;
      case 'understand_structure':
        cypherQuery = this.buildStructureQuery(intent.entities);
        break;
      default:
        cypherQuery = this.buildGeneralGraphQuery(query);
    }
    
    const graphResults = await graphDB.query(cypherQuery);
    
    return graphResults.map(r => ({
      ...r,
      search_type: 'graph'
    }));
  }
}
```

## Response Generation

### Intelligent Result Presentation

```typescript
class MemoryResponseFormatter {
  formatResponse(
    results: UnifiedSearchResult,
    originalQuery: string
  ): string {
    const sections: string[] = [];
    
    // Summary section
    sections.push(this.generateSummary(results, originalQuery));
    
    // Main results
    if (results.results.length > 0) {
      sections.push(this.formatMainResults(results.results));
    }
    
    // Additional context
    if (results.explanation) {
      sections.push(`\n**How I searched:** ${results.explanation}`);
    }
    
    // Follow-up suggestions
    if (results.suggestions.length > 0) {
      sections.push(this.formatSuggestions(results.suggestions));
    }
    
    // Source attribution
    sections.push(this.formatSources(results.results));
    
    return sections.join('\n\n');
  }
  
  private formatMainResults(results: SearchResult[]): string {
    const grouped = this.groupResultsByType(results);
    const formatted: string[] = [];
    
    // Format conversations
    if (grouped.conversations.length > 0) {
      formatted.push('### Previous Discussions\n');
      formatted.push(...grouped.conversations.map(this.formatConversation));
    }
    
    // Format code
    if (grouped.code.length > 0) {
      formatted.push('\n### Related Code\n');
      formatted.push(...grouped.code.map(this.formatCode));
    }
    
    // Format graph relationships  
    if (grouped.graph.length > 0) {
      formatted.push('\n### Code Relationships\n');
      formatted.push(...grouped.graph.map(this.formatGraphResult));
    }
    
    return formatted.join('\n');
  }
  
  private formatConversation(result: SearchResult): string {
    const date = new Date(result.timestamp);
    const preview = this.extractPreview(result.content, 200);
    
    return `**${timeAgo(date)} in ${result.project}**
${preview}
*[View full context](${result.id})*`;
  }
}
```

## Tool Registration and Discovery

```typescript
class MemoryToolRegistry {
  private tools: Map<string, MemoryTool> = new Map();
  private contextInjector: ContextualMemoryInjector;
  private proactiveAssistant: ProactiveMemoryAssistant;
  
  async registerTools(server: MCPServer): Promise<void> {
    // Register all memory tools
    for (const tool of MEMORY_TOOLS) {
      this.tools.set(tool.name, tool);
      
      // Register with MCP server
      await server.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }, tool.handler);
      
      // Register aliases
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          await server.registerAlias(alias, tool.name);
        }
      }
    }
    
    // Set up context monitoring
    this.setupContextMonitoring(server);
  }
  
  private setupContextMonitoring(server: MCPServer): void {
    server.on('message', async (message) => {
      // Check for memory triggers
      const context = await this.contextInjector.processQuery(message.content);
      if (context) {
        // Inject memory context into conversation
        server.injectContext(context);
      }
      
      // Check for proactive suggestions
      const suggestion = await this.proactiveAssistant.suggestMemorySearch(
        message.content,
        message.history
      );
      if (suggestion) {
        server.suggestTool(suggestion);
      }
    });
  }
}
```

## Performance Optimization

### Caching Strategy

```typescript
class MemoryCache {
  private queryCache: LRUCache<string, CachedResult>;
  private embeddingCache: LRUCache<string, number[]>;
  
  constructor() {
    this.queryCache = new LRUCache({
      max: 1000,
      ttl: 5 * 60 * 1000,  // 5 minutes
      updateAgeOnGet: true
    });
    
    this.embeddingCache = new LRUCache({
      max: 10000,
      ttl: 24 * 60 * 60 * 1000,  // 24 hours
      sizeCalculation: (embedding) => embedding.length * 8
    });
  }
  
  async getCachedResult(
    query: string,
    filters: SearchFilters
  ): Promise<CachedResult | null> {
    const key = this.generateCacheKey(query, filters);
    return this.queryCache.get(key);
  }
  
  private generateCacheKey(
    query: string,
    filters: SearchFilters
  ): string {
    const normalized = query.toLowerCase().trim();
    const filterStr = JSON.stringify(filters, Object.keys(filters).sort());
    return crypto
      .createHash('sha256')
      .update(normalized + filterStr)
      .digest('hex');
  }
}
```

## Integration Points

- [Implementation Plan](./implementation-plan.md): Overall architecture
- [PreCompact Hook Design](./precompact-hook-design.md): Data source
- [Peer-to-Peer Design](./peer-to-peer-design.md): Distributed search
- [Graph Index Design](./graph-index-design.md): Graph search integration