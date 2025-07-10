/**
 * Tests for configuration file watching
 */

import { CamilleServer } from '../src/server';
import { ConfigManager } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock dependencies
jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    logServerEvent: jest.fn()
  }
}));

jest.mock('../src/utils/console', () => ({
  consoleOutput: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn()
  },
  isQuietMode: () => true
}));

// Mock OpenAI client
jest.mock('../src/openai-client', () => ({
  OpenAIClient: jest.fn().mockImplementation(() => ({
    generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0)),
    complete: jest.fn().mockResolvedValue('Test summary')
  }))
}));

describe.skip('Configuration File Watching', () => {
  let testConfigDir: string;
  let originalConfigDir: string | undefined;
  let server: CamilleServer;
  let configManager: ConfigManager;
  
  beforeEach(() => {
    // Save original config dir
    originalConfigDir = process.env.CAMILLE_CONFIG_DIR;
    
    // Create test config directory
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-config-test-'));
    process.env.CAMILLE_CONFIG_DIR = testConfigDir;
    
    // Create initial config
    const initialConfig = {
      openaiApiKey: 'test-key',
      watchedDirectories: ['/tmp/test1'],
      ignorePatterns: ['node_modules/**', '*.log']
    };
    
    fs.writeFileSync(
      path.join(testConfigDir, 'config.json'),
      JSON.stringify(initialConfig, null, 2)
    );
    
    // Create test directories
    fs.mkdirSync('/tmp/test1', { recursive: true });
    fs.mkdirSync('/tmp/test2', { recursive: true });
    fs.mkdirSync('/tmp/test3', { recursive: true });
    
    jest.clearAllMocks();
  });
  
  afterEach(async () => {
    // Stop server
    if (server) {
      await server.stop();
    }
    
    // Restore original config dir
    if (originalConfigDir) {
      process.env.CAMILLE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.CAMILLE_CONFIG_DIR;
    }
    
    // Clean up
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    fs.rmSync('/tmp/test1', { recursive: true, force: true });
    fs.rmSync('/tmp/test2', { recursive: true, force: true });
    fs.rmSync('/tmp/test3', { recursive: true, force: true });
  });
  
  describe('Config Watching Setup', () => {
    it('should set up config file watcher on server start', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Verify server is watching initial directory
      const dirs = server.getWatchedDirectories();
      expect(dirs).toContain('/tmp/test1');
      expect(dirs).toHaveLength(1);
    });
    
    it('should handle missing config file gracefully', async () => {
      // Remove config file
      fs.unlinkSync(path.join(testConfigDir, 'config.json'));
      
      // Server should fail to start due to missing API key
      server = new CamilleServer();
      await expect(server.start(['/tmp/test1'])).rejects.toThrow('OpenAI API key not configured');
    });
  });
  
  describe('Directory Changes', () => {
    it('should add new directories when config is updated', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Verify initial state
      expect(server.getWatchedDirectories()).toEqual(['/tmp/test1']);
      
      // Update config to add directory
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test1', '/tmp/test2'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      // Force change event by touching the file
      const configPath = path.join(testConfigDir, 'config.json');
      const stats = fs.statSync(configPath);
      fs.utimesSync(configPath, stats.atime, new Date());
      
      // Wait for file watcher to detect change
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Verify new directory was added
      const dirs = server.getWatchedDirectories();
      expect(dirs).toContain('/tmp/test1');
      expect(dirs).toContain('/tmp/test2');
      expect(dirs).toHaveLength(2);
    });
    
    it('should remove directories when removed from config', async () => {
      // Start with two directories
      const initialConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test1', '/tmp/test2'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(initialConfig, null, 2)
      );
      
      server = new CamilleServer();
      await server.start(['/tmp/test1', '/tmp/test2']);
      
      expect(server.getWatchedDirectories()).toHaveLength(2);
      
      // Update config to remove directory
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test2'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      // Wait for change detection
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify directory was removed
      const dirs = server.getWatchedDirectories();
      expect(dirs).not.toContain('/tmp/test1');
      expect(dirs).toContain('/tmp/test2');
      expect(dirs).toHaveLength(1);
    });
    
    it('should handle complete directory replacement', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Replace all directories
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test2', '/tmp/test3'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const dirs = server.getWatchedDirectories();
      expect(dirs).not.toContain('/tmp/test1');
      expect(dirs).toContain('/tmp/test2');
      expect(dirs).toContain('/tmp/test3');
      expect(dirs).toHaveLength(2);
    });
  });
  
  describe('Configuration Updates', () => {
    it('should update ignore patterns when config changes', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Update config with new ignore patterns
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test1'],
        ignorePatterns: ['node_modules/**', '*.log', '*.tmp', 'dist/**']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify file filter was updated (we'd need to expose this for proper testing)
      // For now, just verify no errors occurred
      expect(server.getStatus().isRunning).toBe(true);
    });
    
    it('should ignore duplicate change events', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      const configPath = path.join(testConfigDir, 'config.json');
      const content = fs.readFileSync(configPath, 'utf8');
      
      // Write same content multiple times
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(configPath, content);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Should still have same directories (no duplicates)
      expect(server.getWatchedDirectories()).toEqual(['/tmp/test1']);
    });
  });
  
  describe('Error Handling', () => {
    it('should handle invalid JSON in config file', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Write invalid JSON
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        '{ invalid json'
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Server should continue running with original config
      expect(server.getStatus().isRunning).toBe(true);
      expect(server.getWatchedDirectories()).toEqual(['/tmp/test1']);
    });
    
    it('should handle non-existent directories in config', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      // Update config with non-existent directory
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test1', '/tmp/non-existent-dir'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Should only watch valid directory
      expect(server.getWatchedDirectories()).toEqual(['/tmp/test1']);
    });
  });
  
  describe('Config Watcher Cleanup', () => {
    it('should close config watcher on server stop', async () => {
      server = new CamilleServer();
      await server.start(['/tmp/test1']);
      
      await server.stop();
      
      // Update config after stop - should not trigger any actions
      const updatedConfig = {
        openaiApiKey: 'test-key',
        watchedDirectories: ['/tmp/test1', '/tmp/test2'],
        ignorePatterns: ['node_modules/**', '*.log']
      };
      
      fs.writeFileSync(
        path.join(testConfigDir, 'config.json'),
        JSON.stringify(updatedConfig, null, 2)
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Server should still be stopped
      expect(server.getStatus().isRunning).toBe(false);
    });
  });
});