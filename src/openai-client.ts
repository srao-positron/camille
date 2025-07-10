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
}

/**
 * OpenAI client wrapper class
 */
export class OpenAIClient {
  private client: OpenAI;
  private config: CamilleConfig;
  private workingDirectory: string;

  constructor(apiKey: string, config: CamilleConfig, workingDirectory: string) {
    this.client = new OpenAI({ apiKey });
    this.config = config;
    this.workingDirectory = workingDirectory;
    logger.debug('OpenAI client initialized', { 
      models: config.models,
      workingDirectory 
    });
  }

  /**
   * Performs a code review using OpenAI
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
   * Handles tool calls for file reading
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
   * Parses the review result from OpenAI response
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
        model: this.config.models.embedding,
        input: content,
        encoding_format: 'float'
      });

      const duration = Date.now() - startTime;
      logger.info('Embedding generated successfully', {
        model: this.config.models.embedding,
        duration,
        tokensUsed: response.usage?.total_tokens
      });
      logger.logOpenAICall(this.config.models.embedding, response.usage?.total_tokens || 0, duration, true);

      return response.data[0].embedding;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Embedding generation failed', error, { 
        model: this.config.models.embedding,
        duration 
      });
      logger.logOpenAICall(this.config.models.embedding, 0, duration, false);
      
      if (error instanceof Error) {
        throw new Error(`Embedding generation error: ${error.message}`);
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