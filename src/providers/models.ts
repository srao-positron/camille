/**
 * Model registry for all supported LLM providers
 */

import { ModelInfo } from './types';

/**
 * Anthropic Claude models
 */
export const ANTHROPIC_MODELS: ModelInfo[] = [
  // Claude 4 Models (Latest)
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 32000,
    pricing: { input: 15, output: 75 },
    supportsTools: true,
    description: 'Most capable model with hybrid reasoning modes'
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 64000,
    pricing: { input: 3, output: 15 },
    supportsTools: true,
    description: 'Balanced performance and cost with extended output'
  },
  
  // Claude 3.7
  {
    id: 'claude-3-7-sonnet-20250219',
    name: 'Claude 3.7 Sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 3, output: 15 },
    supportsTools: true,
    description: 'First hybrid reasoning model'
  },
  
  // Claude 3.5 Models
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 3, output: 15 },
    supportsTools: true,
    description: 'Fast and capable, good for most tasks'
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 0.80, output: 4 },
    supportsTools: true,
    description: 'Fastest and most affordable'
  },
  
  // Claude 3 Models (Legacy)
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 15, output: 75 },
    supportsTools: true,
    description: 'Previous generation flagship model'
  },
  {
    id: 'claude-3-sonnet-20240229',
    name: 'Claude 3 Sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 3, output: 15 },
    supportsTools: true,
    description: 'Previous generation balanced model'
  },
  {
    id: 'claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutput: 4096,
    pricing: { input: 0.25, output: 1.25 },
    supportsTools: true,
    description: 'Previous generation fast model'
  }
];

/**
 * OpenAI GPT models
 */
export const OPENAI_MODELS: ModelInfo[] = [
  // GPT-4.1 Family (Latest)
  {
    id: 'gpt-4.1-2025-04-14',
    name: 'GPT-4.1',
    provider: 'openai',
    contextWindow: 1000000,
    maxOutput: 16384,
    pricing: { input: 10, output: 30 },
    supportsTools: true,
    description: 'Latest model with 1M token context'
  },
  {
    id: 'gpt-4.1-mini-2025-04-14',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    contextWindow: 1000000,
    maxOutput: 16384,
    pricing: { input: 3, output: 12 },
    supportsTools: true,
    description: 'Smaller GPT-4.1 with same context window'
  },
  
  // GPT-4o (Multimodal)
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxOutput: 16384,
    pricing: { input: 5, output: 15 },
    supportsTools: true,
    supportsVision: true,
    description: 'Multimodal flagship model'
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    maxOutput: 16384,
    pricing: { input: 0.15, output: 0.60 },
    supportsTools: true,
    supportsVision: true,
    description: 'Affordable multimodal model'
  },
  
  // GPT-4 Turbo
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai',
    contextWindow: 128000,
    maxOutput: 4096,
    pricing: { input: 10, output: 30 },
    supportsTools: true,
    description: 'Fast GPT-4 with 128K context'
  },
  {
    id: 'gpt-4-turbo-preview',
    name: 'GPT-4 Turbo Preview',
    provider: 'openai',
    contextWindow: 128000,
    maxOutput: 4096,
    pricing: { input: 10, output: 30 },
    supportsTools: true,
    description: 'Latest GPT-4 Turbo preview'
  },
  
  // Standard GPT-4
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    contextWindow: 8192,
    maxOutput: 8192,
    pricing: { input: 30, output: 60 },
    supportsTools: true,
    description: 'Original GPT-4 model'
  },
  
  // O-Series
  {
    id: 'o1',
    name: 'O1',
    provider: 'openai',
    contextWindow: 200000,
    maxOutput: 100000,
    pricing: { input: 15, output: 60 },
    supportsTools: false,
    description: 'Reasoning model with extended thinking'
  },
  {
    id: 'o1-mini',
    name: 'O1 Mini',
    provider: 'openai',
    contextWindow: 128000,
    maxOutput: 65536,
    pricing: { input: 3, output: 12 },
    supportsTools: false,
    description: 'Faster reasoning model'
  },
  {
    id: 'o3',
    name: 'O3',
    provider: 'openai',
    contextWindow: 200000,
    maxOutput: 100000,
    pricing: { input: 20, output: 80 },
    supportsTools: false,
    description: 'Advanced reasoning model'
  },
  {
    id: 'o3-mini',
    name: 'O3 Mini',
    provider: 'openai',
    contextWindow: 200000,
    maxOutput: 65536,
    pricing: { input: 5, output: 20 },
    supportsTools: false,
    description: 'Cost-effective reasoning model'
  }
];

/**
 * Embedding models
 */
export const EMBEDDING_MODELS: ModelInfo[] = [
  {
    id: 'text-embedding-3-large',
    name: 'Text Embedding 3 Large',
    provider: 'openai',
    contextWindow: 8191,
    pricing: { input: 0.13, output: 0 },
    supportsTools: false,
    description: 'High-quality embeddings'
  },
  {
    id: 'text-embedding-3-small',
    name: 'Text Embedding 3 Small',
    provider: 'openai',
    contextWindow: 8191,
    pricing: { input: 0.02, output: 0 },
    supportsTools: false,
    description: 'Fast and affordable embeddings'
  }
];

/**
 * Get all models for a provider
 */
export function getModelsForProvider(provider: 'anthropic' | 'openai'): ModelInfo[] {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_MODELS;
    case 'openai':
      return [...OPENAI_MODELS, ...EMBEDDING_MODELS];
    default:
      return [];
  }
}

/**
 * Get model by ID
 */
export function getModelById(modelId: string): ModelInfo | undefined {
  const allModels = [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...EMBEDDING_MODELS];
  return allModels.find(model => model.id === modelId);
}

/**
 * Get recommended models for each use case
 */
export interface RecommendedModels {
  review: ModelInfo;
  quick: ModelInfo;
  embedding?: ModelInfo;
}

export function getRecommendedModels(provider: 'anthropic' | 'openai'): RecommendedModels {
  if (provider === 'anthropic') {
    return {
      review: ANTHROPIC_MODELS.find(m => m.id === 'claude-opus-4-20250514')!,
      quick: ANTHROPIC_MODELS.find(m => m.id === 'claude-3-5-haiku-20241022')!
    };
  } else {
    return {
      review: OPENAI_MODELS.find(m => m.id === 'gpt-4o')!,
      quick: OPENAI_MODELS.find(m => m.id === 'gpt-4o-mini')!,
      embedding: EMBEDDING_MODELS.find(m => m.id === 'text-embedding-3-large')!
    };
  }
}