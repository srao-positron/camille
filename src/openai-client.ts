/**
 * OpenAI client wrapper for Camille
 * Handles all interactions with OpenAI API including completions and embeddings
 */

import OpenAI from 'openai';
import { CamilleConfig } from './config';
import { FILE_READER_TOOL } from './prompts';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { EmbeddingsIndex } from './embeddings';

/**
 * Metrics for comprehensive code review
 */
export interface ReviewMetrics {
  security: number;              // 0-10 scale
  accuracy: number;              // Will it compile/run correctly?
  algorithmicEfficiency: number; // Algorithm complexity
  codeReuse: number;            // DRY principle adherence
  operationalExcellence: number; // Logging, error handling, metrics
  styleCompliance: number;       // Code style consistency
  objectOriented: number;        // OO design principles
  patterns: number;             // Architecture patterns usage
}

/**
 * Result from a code review
 */
export interface ReviewResult {
  securityIssues: string[];
  complianceViolations: string[];
  codeQualityIssues: string[];
  suggestions: string[];
  approvalStatus: 'APPROVED' | 'NEEDS_CHANGES' | 'REQUIRES_SECURITY_REVIEW';
  rawResponse: string;
  metrics?: ReviewMetrics;  // Optional for backward compatibility
  filesReviewed?: string[]; // Files accessed during review
}

/**
 * OpenAI client wrapper class
 */
export class OpenAIClient {
  private client: OpenAI;
  private config: CamilleConfig;
  private workingDirectory: string;
  private embeddingsIndex?: EmbeddingsIndex;

  constructor(
    apiKey: string, 
    config: CamilleConfig, 
    workingDirectory: string,
    embeddingsIndex?: EmbeddingsIndex
  ) {
    this.client = new OpenAI({ apiKey });
    this.config = config;
    this.workingDirectory = workingDirectory;
    this.embeddingsIndex = embeddingsIndex;
    logger.debug('OpenAI client initialized', { 
      models: config.models,
      workingDirectory,
      hasEmbeddingsIndex: !!embeddingsIndex
    });
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
      model, 
      useDetailedModel,
      promptLength: userPrompt.length,
      hasEmbeddingsIndex: !!this.embeddingsIndex
    });

    try {
      // Define available tools for comprehensive review
      const tools = [
        FILE_READER_TOOL,
        {
          type: 'function' as const,
          function: {
            name: 'search_codebase',
            description: 'Search the codebase for files semantically similar to a query. Use this to find related code, similar patterns, or relevant context.',
            parameters: {
              type: 'object',
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

      const response = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        tools,
        tool_choice: 'auto'
      });

      // Handle tool calls
      let finalResponse = response;
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt },
        response.choices[0].message
      ];

      // Keep handling tool calls until done
      while (finalResponse.choices[0]?.message?.tool_calls?.length && finalResponse.choices[0].message.tool_calls.length > 0) {
        const toolCalls = finalResponse.choices[0].message.tool_calls;
        const toolResults = await this.handleComprehensiveToolCalls(toolCalls, filesReviewed);
        
        messages.push(...toolResults);
        
        // Continue conversation with tool results
        finalResponse = await this.client.chat.completions.create({
          model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          tools,
          tool_choice: 'auto'
        });
        
        messages.push(finalResponse.choices[0].message);
        
        // Break if no more tool calls
        if (!finalResponse.choices[0]?.message?.tool_calls?.length) {
          break;
        }
      }

      const content = finalResponse.choices[0]?.message?.content || '';
      const result = this.parseComprehensiveReviewResult(content);
      result.filesReviewed = filesReviewed;
      
      logger.info('Comprehensive code review completed', {
        model,
        approvalStatus: result.approvalStatus,
        metrics: result.metrics,
        filesReviewed: filesReviewed.length,
        tokensUsed: finalResponse.usage?.total_tokens
      });
      
      return result;

    } catch (error) {
      logger.error('Comprehensive code review failed', error, { model });
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Performs a code review using OpenAI (legacy method)
   */
  async reviewCode(
    systemPrompt: string,
    userPrompt: string,
    useDetailedModel: boolean = true
  ): Promise<ReviewResult> {
    const model = useDetailedModel ? this.config.models.review : this.config.models.quick;
    
    logger.info('Starting code review', { 
      model, 
      useDetailedModel,
      promptLength: userPrompt.length 
    });

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        tools: [FILE_READER_TOOL],
        tool_choice: 'auto'
      });

      // Handle tool calls (file reading)
      let finalResponse = response;
      const toolCalls = response.choices[0]?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        const toolResults = await this.handleToolCalls(toolCalls);
        
        // Continue conversation with tool results
        finalResponse = await this.client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            response.choices[0].message,
            ...toolResults
          ],
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens
        });
      }

      const content = finalResponse.choices[0]?.message?.content || '';
      const result = this.parseReviewResult(content);
      
      logger.info('Code review completed', {
        model,
        approvalStatus: result.approvalStatus,
        securityIssues: result.securityIssues.length,
        complianceViolations: result.complianceViolations.length,
        codeQualityIssues: result.codeQualityIssues.length,
        tokensUsed: finalResponse.usage?.total_tokens
      });
      
      return result;

    } catch (error) {
      logger.error('Code review failed', error, { model });
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Handles tool calls for comprehensive review
   */
  private async handleComprehensiveToolCalls(toolCalls: any[], filesReviewed: string[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'read_file') {
        const args = JSON.parse(toolCall.function.arguments);
        logger.debug('Tool call: read_file', { path: args.path });
        
        // Require absolute paths
        if (!path.isAbsolute(args.path)) {
          results.push({
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            content: 'Error: Absolute path required. Please provide the full absolute path to the file you want to read.'
          });
          continue;
        }
        
        // Security check: Only allow reading files that are in the embeddings index
        const indexedFiles = this.embeddingsIndex?.getIndexedFiles() || [];
        if (!indexedFiles.includes(args.path)) {
          logger.warn('Attempted to read non-indexed file', { path: args.path });
          results.push({
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            content: `Error: File not in indexed codebase. Only files within the indexed directories can be read. Available files: ${indexedFiles.length} files indexed.`
          });
          continue;
        }
        
        const filePath = args.path; // Already absolute
        filesReviewed.push(filePath);
        
        let content: string;
        try {
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
            // Truncate very large files
            const maxFileSize = this.config.maxFileSize || 200000; // Default 200KB
            if (content.length > maxFileSize) {
              logger.info('Truncating large file', { path: filePath, size: content.length, maxSize: maxFileSize });
              content = content.substring(0, maxFileSize) + '\n\n[... file truncated ...]';
            }
            logger.debug('File read successfully', { path: filePath, size: content.length });
          } else {
            logger.warn('File not found for tool call', { path: filePath });
            content = `File not found: ${filePath}`;
          }
        } catch (error) {
          logger.error('Error reading file for tool call', error, { path: filePath });
          content = `Error reading file: ${error}`;
        }

        results.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content
        });
      } else if (toolCall.function.name === 'search_codebase') {
        const args = JSON.parse(toolCall.function.arguments);
        logger.debug('Tool call: search_codebase', { query: args.query, limit: args.limit });
        
        let content: string;
        if (!this.embeddingsIndex || !this.embeddingsIndex.isIndexReady()) {
          content = 'Codebase search is not available. The embeddings index is not ready.';
        } else {
          try {
            // Generate embedding for the query
            const queryEmbedding = await this.generateEmbedding(args.query);
            const searchResults = this.embeddingsIndex.search(queryEmbedding, args.limit || 5);
            
            if (searchResults.length === 0) {
              content = 'No relevant files found for the query.';
            } else {
              content = 'Search Results:\n\n';
              for (const result of searchResults) {
                // Use absolute paths for consistency
                filesReviewed.push(result.path);
                content += `File: ${result.path} (similarity: ${result.similarity.toFixed(3)})\n`;
                if (result.summary) {
                  content += `Summary: ${result.summary}\n`;
                }
                content += '\n';
              }
            }
            
            logger.debug('Codebase search completed', { 
              query: args.query, 
              resultsCount: searchResults.length 
            });
          } catch (error) {
            logger.error('Error searching codebase', error, { query: args.query });
            content = `Error searching codebase: ${error}`;
          }
        }
        
        results.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content
        });
      }
    }

    return results;
  }

  /**
   * Handles tool calls for file reading (legacy)
   */
  private async handleToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'read_file') {
        const args = JSON.parse(toolCall.function.arguments);
        const filePath = path.join(this.workingDirectory, args.path);
        logger.debug('Tool call: read_file', { path: args.path, fullPath: filePath });
        
        let content: string;
        try {
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
            // Truncate very large files
            const maxFileSize = this.config.maxFileSize || 200000; // Default 200KB instead of 50KB
            if (content.length > maxFileSize) {
              logger.info('Truncating large file', { path: args.path, size: content.length, maxSize: maxFileSize });
              content = content.substring(0, maxFileSize) + '\n\n[... file truncated ...]';
            }
            logger.debug('File read successfully', { path: args.path, size: content.length });
          } else {
            logger.warn('File not found for tool call', { path: args.path });
            content = `File not found: ${args.path}`;
          }
        } catch (error) {
          logger.error('Error reading file for tool call', error, { path: args.path });
          content = `Error reading file: ${error}`;
        }

        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content
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
      approvalStatus: 'APPROVED',
      rawResponse: content,
      metrics: {
        security: 5,
        accuracy: 5,
        algorithmicEfficiency: 5,
        codeReuse: 5,
        operationalExcellence: 5,
        styleCompliance: 5,
        objectOriented: 5,
        patterns: 5
      }
    };

    // Parse structured sections from the response
    const sections = content.split(/\*\*([^*]+)\*\*:/);
    
    for (let i = 1; i < sections.length; i += 2) {
      const sectionTitle = sections[i].trim().toLowerCase();
      const sectionContent = sections[i + 1]?.trim() || '';
      
      const items = sectionContent
        .split(/[-•]\s+/)
        .filter(item => item.trim())
        .map(item => item.trim());

      switch (sectionTitle) {
        case 'security issues':
          result.securityIssues = items;
          break;
        case 'compliance violations':
          result.complianceViolations = items;
          break;
        case 'code quality':
        case 'code quality issues':
          result.codeQualityIssues = items;
          break;
        case 'suggestions':
          result.suggestions = items;
          break;
        case 'approval status':
          const status = sectionContent.trim().toUpperCase();
          if (status.includes('REQUIRES_SECURITY_REVIEW')) {
            result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
          } else if (status.includes('NEEDS_CHANGES')) {
            result.approvalStatus = 'NEEDS_CHANGES';
          } else if (status.includes('APPROVED')) {
            result.approvalStatus = 'APPROVED';
          }
          break;
        case 'metrics':
          // Parse metrics from format like "Security: 8/10"
          const metricLines = sectionContent.split('\n');
          for (const line of metricLines) {
            const match = line.match(/(\w+(?:\s+\w+)?):?\s*(\d+)\s*\/\s*10/i);
            if (match) {
              const metricName = match[1].toLowerCase().replace(/\s+/g, '');
              const value = parseInt(match[2]);
              
              if (metricName.includes('security')) result.metrics!.security = value;
              else if (metricName.includes('accuracy')) result.metrics!.accuracy = value;
              else if (metricName.includes('algorithm')) result.metrics!.algorithmicEfficiency = value;
              else if (metricName.includes('reuse')) result.metrics!.codeReuse = value;
              else if (metricName.includes('operational')) result.metrics!.operationalExcellence = value;
              else if (metricName.includes('style')) result.metrics!.styleCompliance = value;
              else if (metricName.includes('object') || metricName.includes('oo')) result.metrics!.objectOriented = value;
              else if (metricName.includes('pattern')) result.metrics!.patterns = value;
            }
          }
          break;
      }
    }

    // Determine approval status based on issues and metrics
    if (result.securityIssues.length > 0 || result.metrics!.security < 7) {
      result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
    } else if (
      result.complianceViolations.length > 0 || 
      result.codeQualityIssues.length > 0 ||
      result.metrics!.accuracy < 7 ||
      result.metrics!.operationalExcellence < 5
    ) {
      result.approvalStatus = 'NEEDS_CHANGES';
    }

    return result;
  }

  /**
   * Parses the review result from OpenAI response (legacy)
   */
  private parseReviewResult(content: string): ReviewResult {
    const result: ReviewResult = {
      securityIssues: [],
      complianceViolations: [],
      codeQualityIssues: [],
      suggestions: [],
      approvalStatus: 'APPROVED',
      rawResponse: content
    };

    // Parse structured sections from the response
    const sections = content.split(/\*\*([^*]+)\*\*:/);
    
    for (let i = 1; i < sections.length; i += 2) {
      const sectionTitle = sections[i].trim().toLowerCase();
      const sectionContent = sections[i + 1]?.trim() || '';
      
      const items = sectionContent
        .split(/[-•]\s+/)
        .filter(item => item.trim())
        .map(item => item.trim());

      switch (sectionTitle) {
        case 'security issues':
          result.securityIssues = items;
          break;
        case 'compliance violations':
          result.complianceViolations = items;
          break;
        case 'code quality':
          result.codeQualityIssues = items;
          break;
        case 'suggestions':
          result.suggestions = items;
          break;
        case 'approval status':
          const status = sectionContent.trim().toUpperCase();
          if (status.includes('REQUIRES_SECURITY_REVIEW')) {
            result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
          } else if (status.includes('NEEDS_CHANGES')) {
            result.approvalStatus = 'NEEDS_CHANGES';
          } else if (status.includes('APPROVED')) {
            result.approvalStatus = 'APPROVED';
          }
          break;
      }
    }

    // Determine approval status based on issues found
    if (result.securityIssues.length > 0) {
      result.approvalStatus = 'REQUIRES_SECURITY_REVIEW';
    } else if (result.complianceViolations.length > 0 || result.codeQualityIssues.length > 0) {
      result.approvalStatus = 'NEEDS_CHANGES';
    }

    return result;
  }

  /**
   * Generates embeddings for code content
   */
  async generateEmbedding(content: string): Promise<number[]> {
    const startTime = Date.now();
    logger.debug('Generating embedding', { 
      model: this.config.models.embedding, 
      inputLength: content.length 
    });
    
    try {
      const response = await this.client.embeddings.create({
        model: this.config.models.embedding || 'text-embedding-3-large',
        input: content,
        encoding_format: 'float'
      });

      const duration = Date.now() - startTime;
      logger.info('Embedding generated successfully', {
        model: this.config.models.embedding,
        duration,
        tokensUsed: response.usage?.total_tokens
      });
      logger.logOpenAICall(this.config.models.embedding || 'text-embedding-3-large', response.usage?.total_tokens || 0, duration, true);

      return response.data[0].embedding;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Embedding generation failed', error, { 
        model: this.config.models.embedding,
        duration 
      });
      logger.logOpenAICall(this.config.models.embedding || 'text-embedding-3-large', 0, duration, false);
      
      if (error instanceof Error) {
        throw new Error(`Embedding generation error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Generates embeddings for multiple content items in batch
   * OpenAI supports up to 100 inputs per request
   */
  async generateBatchEmbeddings(contents: string[]): Promise<number[][]> {
    const startTime = Date.now();
    const model = this.config.models.embedding || 'text-embedding-3-large';
    logger.info('Generating batch embeddings', { 
      model, 
      batchSize: contents.length,
      totalInputLength: contents.reduce((sum, c) => sum + c.length, 0)
    });
    
    try {
      // OpenAI supports up to 100 inputs per request
      const batchSize = 100;
      const results: number[][] = [];
      
      for (let i = 0; i < contents.length; i += batchSize) {
        const batch = contents.slice(i, i + batchSize);
        const response = await this.client.embeddings.create({
          model,
          input: batch,
          encoding_format: 'float'
        });
        
        results.push(...response.data.map(d => d.embedding));
        
        logger.debug('Batch embeddings progress', {
          processed: Math.min(i + batchSize, contents.length),
          total: contents.length,
          tokensUsed: response.usage?.total_tokens
        });
      }

      const duration = Date.now() - startTime;
      const totalBatches = Math.ceil(contents.length / batchSize);
      logger.info('Batch embeddings generated successfully', {
        model,
        duration,
        totalItems: contents.length,
        totalBatches,
        efficiency: contents.length / totalBatches
      });
      
      // Log API call (we made multiple calls but count as batch operation)
      logger.logOpenAICall(model, 0, duration, true);

      return results;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Batch embedding generation failed', error, { 
        model,
        duration,
        batchSize: contents.length
      });
      logger.logOpenAICall(model, 0, duration, false);
      
      if (error instanceof Error) {
        throw new Error(`Batch embedding generation error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Performs a simple completion without tools
   */
  async complete(prompt: string, model?: string): Promise<string> {
    const startTime = Date.now();
    const actualModel = model || this.config.models.quick;
    logger.debug('Starting completion', { 
      model: actualModel, 
      promptLength: prompt.length 
    });
    
    try {
      const response = await this.client.chat.completions.create({
        model: actualModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens
      });

      const duration = Date.now() - startTime;
      logger.info('Completion successful', {
        model: actualModel,
        duration,
        tokensUsed: response.usage?.total_tokens,
        responseLength: response.choices[0]?.message?.content?.length || 0
      });
      logger.logOpenAICall(actualModel, response.usage?.total_tokens || 0, duration, true);

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Completion failed', error, { 
        model: actualModel,
        duration 
      });
      logger.logOpenAICall(actualModel, 0, duration, false);
      
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }
}