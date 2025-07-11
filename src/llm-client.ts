/**
 * Unified LLM client that uses the provider abstraction
 * Provides code review functionality using either Anthropic or OpenAI
 */

import { ConfigManager, CamilleConfig } from './config';
import { createProvider, LLMProviderInterface, LLMMessage, LLMTool } from './providers';
import { ReviewResult, ReviewMetrics } from './openai-client';
import { EmbeddingsIndex } from './embeddings';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { 
  COMPREHENSIVE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  FILE_READER_TOOL 
} from './prompts';

/**
 * Unified LLM client class
 */
export class LLMClient {
  private provider: LLMProviderInterface;
  private openaiProvider?: LLMProviderInterface;
  private config: CamilleConfig;
  private workingDirectory: string;
  private embeddingsIndex?: EmbeddingsIndex;

  constructor(
    config: CamilleConfig,
    workingDirectory: string,
    embeddingsIndex?: EmbeddingsIndex
  ) {
    this.config = config;
    this.workingDirectory = workingDirectory;
    this.embeddingsIndex = embeddingsIndex;
    
    // Create main provider
    const provider = config.provider || 'openai';
    const apiKey = provider === 'anthropic' ? config.anthropicApiKey : config.openaiApiKey;
    
    if (!apiKey) {
      throw new Error(`${provider} API key not configured`);
    }
    
    this.provider = createProvider({
      provider,
      apiKey
    });
    
    // Always create OpenAI provider for embeddings
    if (config.openaiApiKey) {
      this.openaiProvider = createProvider({
        provider: 'openai',
        apiKey: config.openaiApiKey
      });
    }
    
    logger.debug('LLM client initialized', { 
      provider,
      models: config.models,
      workingDirectory,
      hasEmbeddingsIndex: !!embeddingsIndex
    });
  }

  /**
   * Generates embeddings (always uses OpenAI)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openaiProvider || !this.openaiProvider.generateEmbedding) {
      throw new Error('OpenAI API key required for embeddings');
    }
    
    return this.openaiProvider.generateEmbedding(text);
  }

  /**
   * Performs a comprehensive code review with codebase access
   */
  async comprehensiveReview(
    systemPrompt: string,
    userPrompt: string,
    useDetailedModel: boolean = true
  ): Promise<ReviewResult> {
    const model = useDetailedModel ? this.config.models.review : this.config.models.quick;
    const filesReviewed: string[] = [];
    
    logger.info('Starting comprehensive code review', { 
      provider: this.provider.name,
      model, 
      useDetailedModel,
      promptLength: userPrompt.length,
      hasEmbeddingsIndex: !!this.embeddingsIndex
    });

    try {
      // Define available tools for comprehensive review
      const tools: LLMTool[] = [
        FILE_READER_TOOL as LLMTool,
        {
          type: 'function' as const,
          function: {
            name: 'search_codebase',
            description: 'Search the codebase for files semantically similar to a query. Use this to find related code, similar patterns, or relevant context.',
            parameters: {
              type: 'object' as const,
              properties: {
                query: {
                  type: 'string',
                  description: 'Natural language description of what you are looking for'
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 5)',
                  default: 5
                }
              },
              required: ['query']
            }
          }
        }
      ];

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      // Initial request with tools
      const response = await this.provider.complete({
        model,
        messages,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        tools,
        toolChoice: 'auto'
      });

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls
      });

      // Handle tool calls
      while (response.toolCalls && response.toolCalls.length > 0) {
        const toolResults = await this.handleComprehensiveToolCalls(
          response.toolCalls, 
          filesReviewed
        );
        
        messages.push(...toolResults);
        
        // Continue conversation with tool results
        const nextResponse = await this.provider.complete({
          model,
          messages,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          tools,
          toolChoice: 'auto'
        });
        
        messages.push({
          role: 'assistant',
          content: nextResponse.content,
          tool_calls: nextResponse.toolCalls
        });
        
        // Update response for next iteration
        Object.assign(response, nextResponse);
        
        // Break if no more tool calls
        if (!nextResponse.toolCalls || nextResponse.toolCalls.length === 0) {
          break;
        }
      }

      const result = this.parseComprehensiveReviewResult(response.content);
      result.filesReviewed = filesReviewed;
      
      logger.info('Comprehensive code review completed', {
        provider: this.provider.name,
        model,
        approvalStatus: result.approvalStatus,
        metrics: result.metrics,
        filesReviewed: filesReviewed.length,
        tokensUsed: response.usage?.totalTokens
      });
      
      return result;

    } catch (error) {
      logger.error('Comprehensive code review failed', error, { 
        provider: this.provider.name,
        model 
      });
      if (error instanceof Error) {
        throw new Error(`LLM API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Performs a code review (legacy method without tools)
   */
  async reviewCode(
    systemPrompt: string,
    userPrompt: string,
    useDetailedModel: boolean = true
  ): Promise<ReviewResult> {
    const model = useDetailedModel ? this.config.models.review : this.config.models.quick;
    
    logger.info('Starting code review', { 
      provider: this.provider.name,
      model, 
      useDetailedModel,
      promptLength: userPrompt.length 
    });

    try {
      const response = await this.provider.complete({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      });

      const result = this.parseReviewResult(response.content);
      
      logger.info('Code review completed', {
        provider: this.provider.name,
        model,
        approvalStatus: result.approvalStatus,
        tokensUsed: response.usage?.totalTokens
      });
      
      return result;

    } catch (error) {
      logger.error('Code review failed', error, { 
        provider: this.provider.name,
        model 
      });
      if (error instanceof Error) {
        throw new Error(`LLM API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Handles tool calls for comprehensive review
   */
  private async handleComprehensiveToolCalls(
    toolCalls: any[],
    filesReviewed: string[]
  ): Promise<any[]> {
    const results = [];
    
    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments);
      
      switch (toolCall.function.name) {
        case 'read_file':
          // Require absolute paths
          if (!path.isAbsolute(args.path)) {
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: 'Error: Absolute path required. Please provide the full absolute path to the file you want to read.'
            });
            continue;
          }

          // Only allow reading files that are indexed
          if (this.embeddingsIndex) {
            const indexedFiles = this.embeddingsIndex.getIndexedFiles();
            if (!indexedFiles.includes(args.path)) {
              results.push({
                role: 'tool' as const,
                tool_call_id: toolCall.id,
                content: `Error: File ${args.path} is not in the indexed codebase. Only files in the monitored directories can be accessed.`
              });
              continue;
            }
          }

          try {
            // Check file size
            const stats = fs.statSync(args.path);
            if (stats.size > (this.config.maxFileSize || 200000)) {
              results.push({
                role: 'tool' as const,
                tool_call_id: toolCall.id,
                content: `Error: File too large (${stats.size} bytes). Maximum allowed: ${this.config.maxFileSize || 200000} bytes.`
              });
              continue;
            }

            const content = fs.readFileSync(args.path, 'utf8');
            filesReviewed.push(args.path);
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: content
            });
          } catch (error) {
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
          }
          break;

        case 'search_codebase':
          if (!this.embeddingsIndex) {
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: 'Error: Codebase search is not available. Embeddings index not initialized.'
            });
            continue;
          }

          try {
            const queryEmbedding = await this.generateEmbedding(args.query);
            const searchResults = this.embeddingsIndex.search(queryEmbedding, args.limit || 5);
            
            const formattedResults = searchResults.map((result: any) => 
              `File: ${result.path}\nSimilarity: ${result.similarity.toFixed(3)}\nSummary: ${result.summary || 'No summary available'}\n`
            ).join('\n---\n');
            
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: formattedResults || 'No matching files found.'
            });
          } catch (error) {
            results.push({
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: `Error searching codebase: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
          }
          break;

        default:
          results.push({
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            content: `Error: Unknown tool ${toolCall.function.name}`
          });
      }
    }
    
    return results;
  }

  /**
   * Parses comprehensive review result with metrics
   */
  private parseComprehensiveReviewResult(content: string): ReviewResult {
    const result: ReviewResult = {
      securityIssues: [],
      complianceViolations: [],
      codeQualityIssues: [],
      suggestions: [],
      approvalStatus: 'NEEDS_CHANGES',
      rawResponse: content,
      metrics: undefined
    };

    // Extract metrics
    const metricsMatch = content.match(/\*\*Metrics:\*\*[\s\S]*?(?=\*\*|$)/);
    if (metricsMatch) {
      const metricsText = metricsMatch[0];
      const metrics: ReviewMetrics = {
        security: this.extractMetric(metricsText, 'Security'),
        accuracy: this.extractMetric(metricsText, 'Accuracy'),
        algorithmicEfficiency: this.extractMetric(metricsText, 'Algorithmic Efficiency'),
        codeReuse: this.extractMetric(metricsText, 'Code Reuse'),
        operationalExcellence: this.extractMetric(metricsText, 'Operational Excellence'),
        styleCompliance: this.extractMetric(metricsText, 'Style Compliance'),
        objectOriented: this.extractMetric(metricsText, 'Object-Oriented Design'),
        patterns: this.extractMetric(metricsText, 'Architecture Patterns')
      };
      result.metrics = metrics;
    }

    // Extract sections
    const sections = {
      security: /\*\*Security Issues:\*\*([\s\S]*?)(?=\*\*|$)/,
      compliance: /\*\*Compliance Violations:\*\*([\s\S]*?)(?=\*\*|$)/,
      quality: /\*\*Code Quality Issues:\*\*([\s\S]*?)(?=\*\*|$)/,
      suggestions: /\*\*Suggestions:\*\*([\s\S]*?)(?=\*\*|$)/,
      approval: /\*\*Approval Status:\*\*\s*(\w+)/
    };

    // Parse each section
    const securityMatch = content.match(sections.security);
    if (securityMatch) {
      result.securityIssues = this.parseListItems(securityMatch[1]);
    }

    const complianceMatch = content.match(sections.compliance);
    if (complianceMatch) {
      result.complianceViolations = this.parseListItems(complianceMatch[1]);
    }

    const qualityMatch = content.match(sections.quality);
    if (qualityMatch) {
      result.codeQualityIssues = this.parseListItems(qualityMatch[1]);
    }

    const suggestionsMatch = content.match(sections.suggestions);
    if (suggestionsMatch) {
      result.suggestions = this.parseListItems(suggestionsMatch[1]);
    }

    const approvalMatch = content.match(sections.approval);
    if (approvalMatch) {
      const status = approvalMatch[1].toUpperCase();
      if (['APPROVED', 'NEEDS_CHANGES', 'REQUIRES_SECURITY_REVIEW'].includes(status)) {
        result.approvalStatus = status as 'APPROVED' | 'NEEDS_CHANGES' | 'REQUIRES_SECURITY_REVIEW';
      }
    }

    return result;
  }

  /**
   * Parses standard review result
   */
  private parseReviewResult(content: string): ReviewResult {
    return this.parseComprehensiveReviewResult(content);
  }

  /**
   * Extracts a metric value from text
   */
  private extractMetric(text: string, metricName: string): number {
    const regex = new RegExp(`${metricName}:\\s*(\\d+)(?:\\/10)?`, 'i');
    const match = text.match(regex);
    return match ? parseInt(match[1], 10) : 5;
  }

  /**
   * Parses list items from a section
   */
  private parseListItems(text: string): string[] {
    const items = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('-') || line.startsWith('*') || line.startsWith('•'))
      .map(line => line.replace(/^[-*•]\s*/, '').trim())
      .filter(line => line.length > 0);
    
    return items;
  }
}