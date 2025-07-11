/**
 * OpenAI GPT provider implementation
 */

import OpenAI from 'openai';
import { 
  LLMProviderInterface, 
  LLMRequestParams, 
  LLMResponse, 
  ModelInfo,
  LLMMessage,
  LLMTool
} from './types';
import { OPENAI_MODELS, EMBEDDING_MODELS } from './models';
import { logger } from '../logger';

/**
 * Convert our generic message format to OpenAI's format
 */
function convertToOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map(msg => {
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content,
        tool_call_id: msg.tool_call_id!
      };
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      return {
        role: 'assistant' as const,
        content: msg.content || null,
        tool_calls: msg.tool_calls
      };
    } else {
      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content
      };
    }
  });
}

/**
 * OpenAI GPT provider
 */
export class OpenAIProvider implements LLMProviderInterface {
  name: 'openai' = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(params: LLMRequestParams): Promise<LLMResponse> {
    const startTime = Date.now();
    
    try {
      // Prepare request parameters
      const requestParams: OpenAI.ChatCompletionCreateParams = {
        model: params.model,
        messages: convertToOpenAIMessages(params.messages),
        temperature: params.temperature,
        max_tokens: params.maxTokens
      };
      
      // Add tools if provided
      if (params.tools && params.tools.length > 0) {
        requestParams.tools = params.tools;
        
        if (params.toolChoice === 'auto') {
          requestParams.tool_choice = 'auto';
        } else if (params.toolChoice === 'none') {
          requestParams.tool_choice = 'none';
        } else if (params.toolChoice && typeof params.toolChoice === 'object') {
          requestParams.tool_choice = {
            type: 'function',
            function: { name: params.toolChoice.name }
          };
        }
      }
      
      logger.debug('Calling OpenAI API', {
        model: params.model,
        messageCount: params.messages.length,
        hasTools: !!params.tools,
        temperature: params.temperature
      });
      
      const response = await this.client.chat.completions.create(requestParams);
      
      const duration = Date.now() - startTime;
      logger.info('OpenAI API call successful', {
        model: params.model,
        duration,
        tokensUsed: response.usage?.total_tokens
      });
      
      const choice = response.choices[0];
      
      return {
        content: choice.message.content || '',
        toolCalls: choice.message.tool_calls,
        usage: response.usage ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        } : undefined,
        model: response.model
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('OpenAI API call failed', error, {
        model: params.model,
        duration
      });
      
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const startTime = Date.now();
    
    try {
      const response = await this.client.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
        encoding_format: 'float'
      });
      
      const duration = Date.now() - startTime;
      logger.debug('Embedding generated', {
        model: 'text-embedding-3-large',
        duration,
        dimensions: response.data[0].embedding.length
      });
      
      return response.data[0].embedding;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Embedding generation failed', error, { duration });
      
      if (error instanceof Error) {
        throw new Error(`Embedding error: ${error.message}`);
      }
      throw error;
    }
  }

  getAvailableModels(): ModelInfo[] {
    return [...OPENAI_MODELS, ...EMBEDDING_MODELS];
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Make a minimal API call to validate the key
      await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1
      });
      return true;
    } catch (error) {
      logger.debug('API key validation failed', { error });
      return false;
    }
  }
}