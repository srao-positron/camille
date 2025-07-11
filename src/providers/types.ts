/**
 * Common types and interfaces for LLM providers
 */

/**
 * Supported LLM providers
 */
export type LLMProvider = 'anthropic' | 'openai';

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: LLMProvider;
  contextWindow: number;
  maxOutput?: number;
  pricing: {
    input: number;  // per million tokens
    output: number; // per million tokens
  };
  supportsTools: boolean;
  supportsVision?: boolean;
  description?: string;
}

/**
 * Tool definition for LLM APIs
 */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/**
 * Message format for LLM APIs
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

/**
 * Common parameters for LLM requests
 */
export interface LLMRequestParams {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LLMTool[];
  toolChoice?: 'auto' | 'none' | { type: 'tool'; name: string };
}

/**
 * Result from an LLM request
 */
export interface LLMResponse {
  content: string;
  toolCalls?: any[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model: string;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  provider: LLMProvider;
  apiKey: string;
  models: {
    review: string;
    quick: string;
    embedding?: string;
  };
}

/**
 * LLM Provider interface
 */
export interface LLMProviderInterface {
  name: LLMProvider;
  
  /**
   * Complete a chat request
   */
  complete(params: LLMRequestParams): Promise<LLMResponse>;
  
  /**
   * Generate embeddings for text
   */
  generateEmbedding?(text: string): Promise<number[]>;
  
  /**
   * Get available models
   */
  getAvailableModels(): ModelInfo[];
  
  /**
   * Validate API key
   */
  validateApiKey?(): Promise<boolean>;
}