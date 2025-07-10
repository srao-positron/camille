/**
 * Tests for configuration management
 */

import { ConfigManager } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  const testConfigDir = path.join(os.tmpdir(), '.camille-test');
  
  beforeEach(() => {
    // Mock home directory
    jest.spyOn(os, 'homedir').mockReturnValue(os.tmpdir());
    
    // Clean up test directory
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    
    // Set test environment variable
    process.env.OPENAI_API_KEY = 'test-key-from-env';
    
    configManager = new ConfigManager();
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    delete process.env.OPENAI_API_KEY;
    jest.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create config directory if it does not exist', () => {
      expect(fs.existsSync(testConfigDir)).toBe(true);
    });

    it('should load API key from environment variable', () => {
      expect(configManager.getApiKey()).toBe('test-key-from-env');
    });

    it('should use default configuration values', () => {
      const config = configManager.getConfig();
      expect(config.models.review).toBe('gpt-4-turbo-preview');
      expect(config.models.quick).toBe('gpt-4o-mini');
      expect(config.models.embedding).toBe('text-embedding-3-small');
      expect(config.temperature).toBe(0.1);
      expect(config.cacheToDisk).toBe(false);
    });
  });

  describe('setApiKey', () => {
    it('should save API key to config file', () => {
      configManager.setApiKey('new-test-key');
      
      const configPath = path.join(testConfigDir, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(savedConfig.openaiApiKey).toBe('new-test-key');
    });

    it('should update in-memory configuration', () => {
      configManager.setApiKey('new-test-key');
      expect(configManager.getApiKey()).toBe('new-test-key');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration values', () => {
      configManager.updateConfig({
        temperature: 0.5,
        cacheToDisk: true,
        models: {
          review: 'gpt-4',
          quick: 'gpt-3.5-turbo',
          embedding: 'text-embedding-ada-002'
        }
      });

      const config = configManager.getConfig();
      expect(config.temperature).toBe(0.5);
      expect(config.cacheToDisk).toBe(true);
      expect(config.models.review).toBe('gpt-4');
    });

    it('should persist updates to file', () => {
      configManager.updateConfig({ temperature: 0.7 });
      
      // Create new instance to test persistence
      const newConfigManager = new ConfigManager();
      const config = newConfigManager.getConfig();
      expect(config.temperature).toBe(0.7);
    });
  });

  describe('custom prompts', () => {
    it('should save custom prompts', () => {
      const customPrompt = 'This is a custom system prompt';
      configManager.saveCustomPrompt('system', customPrompt);
      
      const promptPath = path.join(testConfigDir, 'prompts', 'system.txt');
      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.readFileSync(promptPath, 'utf8')).toBe(customPrompt);
    });

    it('should load custom prompts', () => {
      const customPrompt = 'This is a custom review prompt';
      configManager.saveCustomPrompt('review', customPrompt);
      
      const loaded = configManager.loadCustomPrompt('review');
      expect(loaded).toBe(customPrompt);
    });

    it('should return undefined for non-existent prompts', () => {
      const loaded = configManager.loadCustomPrompt('non-existent');
      expect(loaded).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw error when API key is not set', () => {
      delete process.env.OPENAI_API_KEY;
      const newConfigManager = new ConfigManager();
      
      expect(() => newConfigManager.getApiKey()).toThrow('OpenAI API key not configured');
    });
  });
});