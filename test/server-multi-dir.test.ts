/**
 * Tests for multi-directory server functionality
 */

// Mock dependencies BEFORE imports
jest.mock('../src/openai-client');

// Create chokidar mock
const EventEmitter = require('events').EventEmitter;
const mockWatch = jest.fn();
jest.mock('chokidar', () => {
  class FSWatcher extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
    }
    close() {
      this.closed = true;
      this.emit('close');
      this.removeAllListeners();
    }
    add(paths: any) {
      return this;
    }
    unwatch(paths: any) {
      return this;
    }
    getWatched() {
      return {};
    }
  }
  
  mockWatch.mockImplementation((paths: any, options: any) => {
    const watcher = new FSWatcher();
    if (!options?.ignoreInitial) {
      setImmediate(() => {
        if (typeof paths === 'string') {
          watcher.emit('add', paths);
        } else if (Array.isArray(paths)) {
          paths.forEach((p: string) => watcher.emit('add', p));
        }
        watcher.emit('ready');
      });
    }
    return watcher;
  });
  
  return {
    watch: mockWatch,
    FSWatcher
  };
});

import { CamilleServer, ServerManager } from '../src/server';
import { ConfigManager } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Multi-Directory Server Functionality', () => {
  let server: CamilleServer;
  let testBaseDir: string;
  let testDir1: string;
  let testDir2: string;
  let testDir3: string;


  beforeEach(() => {
    // Reset ServerManager instance
    (ServerManager as any).instance = undefined;
    
    // Set up test config directory
    process.env.CAMILLE_CONFIG_DIR = path.join(os.tmpdir(), '.camille-test-server');
    
    // Set up test directories
    testBaseDir = path.join(os.tmpdir(), 'camille-test-multi');
    testDir1 = path.join(testBaseDir, 'project1');
    testDir2 = path.join(testBaseDir, 'project2');
    testDir3 = path.join(testBaseDir, 'project3');

    // Create test directories
    [testBaseDir, testDir1, testDir2, testDir3].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // Create test files
    fs.writeFileSync(path.join(testDir1, 'file1.js'), 'console.log("project1");');
    fs.writeFileSync(path.join(testDir2, 'file2.js'), 'console.log("project2");');
    fs.writeFileSync(path.join(testDir3, 'file3.js'), 'console.log("project3");');

    // Mock config manager
    jest.spyOn(ConfigManager.prototype, 'getApiKey').mockReturnValue('test-key');
    jest.spyOn(ConfigManager.prototype, 'getConfig').mockReturnValue({
      openaiApiKey: 'test-key',
      models: {
        review: 'gpt-4-turbo-preview',
        quick: 'gpt-4o-mini',
        embedding: 'text-embedding-3-small'
      },
      temperature: 0.1,
      maxTokens: 4000,
      cacheToDisk: false,
      ignorePatterns: ['node_modules/**', '*.log']
    });

    // Mock OpenAI client
    const mockOpenAIClient = {
      generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      complete: jest.fn().mockResolvedValue('Test summary')
    };
    
    jest.requireMock('../src/openai-client').OpenAIClient.mockImplementation(() => mockOpenAIClient);
  });

  afterEach(async () => {
    // Clean up
    try {
      await ServerManager.stop();
    } catch (error) {
      // Ignore if server not running
    }
    
    // Clean up PID file
    const pidFile = path.join(
      process.env.CAMILLE_CONFIG_DIR || path.join(os.homedir(), '.camille'),
      'server.pid'
    );
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
    
    delete process.env.CAMILLE_CONFIG_DIR;
    jest.restoreAllMocks();
  });

  describe('Starting with multiple directories', () => {
    it('should start server with single directory', async () => {
      server = new CamilleServer();
      await server.start(testDir1);

      const status = server.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.watchedDirectories).toHaveLength(1);
      expect(status.watchedDirectories[0]).toBe(testDir1);
    });

    it('should start server with multiple directories', async () => {
      server = new CamilleServer();
      await server.start([testDir1, testDir2, testDir3]);

      const status = server.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.watchedDirectories).toHaveLength(3);
      expect(status.watchedDirectories).toContain(testDir1);
      expect(status.watchedDirectories).toContain(testDir2);
      expect(status.watchedDirectories).toContain(testDir3);
    });

    it('should handle empty array gracefully', async () => {
      server = new CamilleServer();
      await server.start([]);

      const status = server.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.watchedDirectories).toHaveLength(0);
    });
  });

  describe('Adding directories', () => {
    beforeEach(async () => {
      server = new CamilleServer();
      await server.start(testDir1);
    });

    it('should add a new directory', async () => {
      await server.addDirectory(testDir2);

      const status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(2);
      expect(status.watchedDirectories).toContain(testDir1);
      expect(status.watchedDirectories).toContain(testDir2);
    });

    it('should not add duplicate directory', async () => {
      await server.addDirectory(testDir1);

      const status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(1);
    });

    it('should throw error for non-existent directory', async () => {
      const nonExistentDir = path.join(testBaseDir, 'non-existent');
      
      await expect(server.addDirectory(nonExistentDir))
        .rejects.toThrow('Not a valid directory');
    });

    it('should throw error for file path', async () => {
      const filePath = path.join(testDir1, 'file1.js');
      
      await expect(server.addDirectory(filePath))
        .rejects.toThrow('Not a valid directory');
    });

    it('should handle relative paths', async () => {
      const cwd = process.cwd();
      process.chdir(testBaseDir);
      
      await server.addDirectory('./project3');
      
      const status = server.getStatus();
      // Normalize paths to handle macOS symlinks (e.g., /var -> /private/var)
      const normalizedWatchedDirs = status.watchedDirectories.map(dir => fs.realpathSync(dir));
      const normalizedTestDir3 = fs.realpathSync(testDir3);
      expect(normalizedWatchedDirs).toContain(normalizedTestDir3);
      
      process.chdir(cwd);
    });
  });

  describe('Removing directories', () => {
    beforeEach(async () => {
      server = new CamilleServer();
      await server.start([testDir1, testDir2, testDir3]);
    });

    it('should remove a watched directory', async () => {
      await server.removeDirectory(testDir2);

      const status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(2);
      expect(status.watchedDirectories).toContain(testDir1);
      expect(status.watchedDirectories).toContain(testDir3);
      expect(status.watchedDirectories).not.toContain(testDir2);
    });

    it('should handle removing non-watched directory', async () => {
      const notWatched = path.join(testBaseDir, 'not-watched');
      await server.removeDirectory(notWatched);

      const status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(3);
    });

    it('should remove all files from index when removing directory', async () => {
      // Mock the embeddings index
      const mockIndexedFiles = [
        path.join(testDir1, 'file1.js'),
        path.join(testDir2, 'file2.js'),
        path.join(testDir2, 'subdir', 'file.js'),
        path.join(testDir3, 'file3.js')
      ];
      
      const mockRemoveFile = jest.fn();
      jest.spyOn(server['embeddingsIndex'], 'getIndexedFiles')
        .mockReturnValue(mockIndexedFiles);
      jest.spyOn(server['embeddingsIndex'], 'removeFile')
        .mockImplementation(mockRemoveFile);

      await server.removeDirectory(testDir2);

      expect(mockRemoveFile).toHaveBeenCalledWith(path.join(testDir2, 'file2.js'));
      expect(mockRemoveFile).toHaveBeenCalledWith(path.join(testDir2, 'subdir', 'file.js'));
      expect(mockRemoveFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('Status and listing', () => {
    it('should return correct watched directories', async () => {
      server = new CamilleServer();
      await server.start([testDir1, testDir2]);

      const dirs = server.getWatchedDirectories();
      expect(dirs).toHaveLength(2);
      expect(dirs).toContain(testDir1);
      expect(dirs).toContain(testDir2);
    });

    it('should update status when directories change', async () => {
      server = new CamilleServer();
      await server.start(testDir1);

      let status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(1);

      await server.addDirectory(testDir2);
      status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(2);

      await server.removeDirectory(testDir1);
      status = server.getStatus();
      expect(status.watchedDirectories).toHaveLength(1);
      expect(status.watchedDirectories[0]).toBe(testDir2);
    });
  });

  describe('File watching across directories', () => {
    it('should set up watchers for each directory', async () => {
      const chokidar = require('chokidar');
      const mockWatch = jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined)
      });
      chokidar.watch = mockWatch;

      server = new CamilleServer();
      await server.start([testDir1, testDir2]);

      expect(mockWatch).toHaveBeenCalledTimes(2);
      expect(mockWatch).toHaveBeenCalledWith(
        testDir1,
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true
        })
      );
      expect(mockWatch).toHaveBeenCalledWith(
        testDir2,
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true
        })
      );
    });

    it('should close watchers when removing directories', async () => {
      const mockClose = jest.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: jest.fn().mockReturnThis(),
        close: mockClose
      };
      
      const chokidar = require('chokidar');
      chokidar.watch = jest.fn().mockReturnValue(mockWatcher);

      server = new CamilleServer();
      await server.start([testDir1, testDir2]);
      await server.removeDirectory(testDir1);

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Server stop behavior', () => {
    it('should close all watchers when stopping', async () => {
      const mockClose = jest.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: jest.fn().mockReturnThis(),
        close: mockClose
      };
      
      const chokidar = require('chokidar');
      chokidar.watch = jest.fn().mockReturnValue(mockWatcher);

      server = new CamilleServer();
      await server.start([testDir1, testDir2, testDir3]);
      await server.stop();

      expect(mockClose).toHaveBeenCalledTimes(3);
      expect(server.getWatchedDirectories()).toHaveLength(0);
    });
  });

  describe('ServerManager with multiple directories', () => {
    it('should start with multiple directories through ServerManager', async () => {
      const instance = await ServerManager.start([testDir1, testDir2]);
      
      expect(instance).toBeDefined();
      const status = instance.getStatus();
      expect(status.watchedDirectories).toHaveLength(2);
    });

    it('should maintain singleton instance', async () => {
      const instance1 = await ServerManager.start(testDir1);
      
      // Second start should throw error
      await expect(ServerManager.start(testDir2)).rejects.toThrow('Camille server is already running');
      
      // Get instance should return same instance
      const instance2 = ServerManager.getInstance();
      expect(instance1).toBe(instance2);
      expect(instance1.getWatchedDirectories()).toHaveLength(1);
      expect(instance1.getWatchedDirectories()[0]).toBe(testDir1);
    });
  });
});