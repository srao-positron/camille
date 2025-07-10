/**
 * Configuration management module for Camille
 * Handles API keys, model settings, and custom prompts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config as dotenvConfig } from 'dotenv';

/**
 * Interface for Camille configuration options
 */
export interface CamilleConfig {
  openaiApiKey?: string;
  models: {
    review: string;      // Model for detailed code review (default: gpt-4-turbo-preview)
    quick: string;       // Model for quick checks (default: gpt-4o-mini)
    embedding: string;   // Model for embeddings (default: text-embedding-3-small)
  };
  temperature: number;   // Low temperature for consistent results (default: 0.1)
  maxTokens: number;     // Maximum tokens for responses
  cacheToDisk: boolean;  // Whether to persist embeddings to disk
  ignorePatterns: string[]; // File patterns to ignore (gitignore format)
  customPrompts?: {
    system?: string;     // Custom system prompt
    review?: string;     // Custom review prompt template
  };
  watchedDirectories?: string[]; // Directories being monitored
  mcp?: {
    enabled: boolean;
    autoStart?: boolean;
  };
  hooks?: {
    enabled: boolean;
    tools?: string[];
  };
  autoStart?: {
    enabled: boolean;
    platform?: string;
    method?: string;
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: CamilleConfig = {
  models: {
    review: 'gpt-4-turbo-preview',
    quick: 'gpt-4o-mini',
    embedding: 'text-embedding-3-small'
  },
  temperature: 0.1,
  maxTokens: 4000,
  cacheToDisk: false,
  ignorePatterns: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    '*.log',
    '*.tmp',
    '.DS_Store'
  ]
};

/**
 * Configuration manager class
 */
export class ConfigManager {
  private configDir: string;
  private configPath: string;
  private config: CamilleConfig;

  constructor() {
    this.configDir = path.join(os.homedir(), '.camille');
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = this.loadConfig();
  }

  /**
   * Ensures the configuration directory exists
   */
  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Loads configuration from file or creates default
   */
  private loadConfig(): CamilleConfig {
    this.ensureConfigDir();

    // Load from environment first
    dotenvConfig();
    
    let config: CamilleConfig = { ...DEFAULT_CONFIG };

    // Load from config file if exists
    if (fs.existsSync(this.configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        config = { ...config, ...fileConfig };
      } catch (error) {
        console.error('Error loading config file:', error);
      }
    }

    // Override with environment variables
    if (process.env.OPENAI_API_KEY) {
      config.openaiApiKey = process.env.OPENAI_API_KEY;
    }

    return config;
  }

  /**
   * Saves the current configuration to file
   */
  public saveConfig(): void {
    this.ensureConfigDir();
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Gets the OpenAI API key
   * @throws Error if API key is not set
   */
  public getApiKey(): string {
    if (!this.config.openaiApiKey) {
      throw new Error('OpenAI API key not configured. Run "camille --set-key <key>" or set OPENAI_API_KEY environment variable.');
    }
    return this.config.openaiApiKey;
  }

  /**
   * Sets the OpenAI API key
   */
  public setApiKey(key: string): void {
    this.config.openaiApiKey = key;
    this.saveConfig();
  }

  /**
   * Gets the current configuration
   */
  public getConfig(): CamilleConfig {
    return { ...this.config };
  }

  /**
   * Updates configuration values
   */
  public updateConfig(updates: Partial<CamilleConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  /**
   * Gets the path to custom prompts directory
   */
  public getPromptsDir(): string {
    return path.join(this.configDir, 'prompts');
  }

  /**
   * Loads custom prompt from file
   */
  public loadCustomPrompt(name: string): string | undefined {
    const promptPath = path.join(this.getPromptsDir(), `${name}.txt`);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf8');
    }
    return undefined;
  }

  /**
   * Saves custom prompt to file
   */
  public saveCustomPrompt(name: string, content: string): void {
    const promptsDir = this.getPromptsDir();
    if (!fs.existsSync(promptsDir)) {
      fs.mkdirSync(promptsDir, { recursive: true });
    }
    const promptPath = path.join(promptsDir, `${name}.txt`);
    fs.writeFileSync(promptPath, content);
  }
}