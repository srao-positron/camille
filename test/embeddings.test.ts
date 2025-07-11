/**
 * Tests for embeddings functionality
 */

// Mock fs module before imports
jest.mock('fs');

import { EmbeddingsIndex, FileFilter } from '../src/embeddings';
import { ConfigManager } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('EmbeddingsIndex', () => {
  let embeddingsIndex: EmbeddingsIndex;
  let configManager: ConfigManager;
  const testDir = path.join(os.tmpdir(), '.camille-test-embeddings');

  beforeEach(() => {
    // Mock config manager
    configManager = {
      getConfig: jest.fn().mockReturnValue({
        cacheToDisk: false,
        ignorePatterns: []
      }),
      configDir: testDir
    } as any;

    // Setup fs mocks
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.mkdirSync as jest.Mock).mockImplementation(() => {});
    (fs.readFileSync as jest.Mock).mockImplementation(() => '{}');
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});

    embeddingsIndex = new EmbeddingsIndex(configManager);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addEmbedding', () => {
    it('should add file to index', () => {
      const testFile = '/test/file.js';
      const embedding = new Array(1536).fill(0.1);
      const content = 'test content';

      // Mock fs methods
      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 123456789
      });

      embeddingsIndex.addEmbedding(testFile, embedding, content, 'test summary');

      expect(embeddingsIndex.getIndexSize()).toBe(1);
      expect(embeddingsIndex.getIndexedFiles()).toContain(testFile);
    });

    it('should update existing file', () => {
      const testFile = '/test/file.js';
      const embedding1 = new Array(1536).fill(0.1);
      const embedding2 = new Array(1536).fill(0.2);

      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 123456789
      });

      embeddingsIndex.addEmbedding(testFile, embedding1, 'content1');
      embeddingsIndex.addEmbedding(testFile, embedding2, 'content2');

      expect(embeddingsIndex.getIndexSize()).toBe(1);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 123456789
      });

      // Add test files with different embeddings
      const files = [
        { path: '/test/auth.js', embedding: [1, 0, 0, 0] },
        { path: '/test/database.js', embedding: [0, 1, 0, 0] },
        { path: '/test/api.js', embedding: [0, 0, 1, 0] },
        { path: '/test/utils.js', embedding: [0, 0, 0, 1] }
      ];

      files.forEach(file => {
        embeddingsIndex.addEmbedding(
          file.path,
          file.embedding,
          `content of ${file.path}`,
          `Summary of ${file.path}`
        );
      });
    });

    it('should find most similar files', () => {
      const queryEmbedding = [0.9, 0.1, 0, 0]; // Most similar to auth.js
      const results = embeddingsIndex.search(queryEmbedding, 2);

      expect(results).toHaveLength(2);
      expect(results[0].path).toBe('/test/auth.js');
      expect(results[0].similarity).toBeGreaterThan(0.9);
    });

    it('should return empty array for empty index', () => {
      const emptyIndex = new EmbeddingsIndex(configManager);
      const results = emptyIndex.search([1, 0, 0, 0]);
      expect(results).toHaveLength(0);
    });

    it('should limit results', () => {
      const queryEmbedding = [0.25, 0.25, 0.25, 0.25];
      const results = embeddingsIndex.search(queryEmbedding, 2);
      expect(results).toHaveLength(2);
    });
  });

  describe('needsReindex', () => {
    it('should return true for non-indexed file', () => {
      expect(embeddingsIndex.needsReindex('/new/file.js')).toBe(true);
    });

    it('should return true for modified file', () => {
      const testFile = '/test/file.js';
      
      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 100
      });
      (fs.readFileSync as jest.Mock).mockReturnValue('original content');

      embeddingsIndex.addEmbedding(testFile, [1, 0, 0, 0], 'original content');

      // Mock file change
      (fs.readFileSync as jest.Mock).mockReturnValue('modified content');

      expect(embeddingsIndex.needsReindex(testFile)).toBe(true);
    });

    it('should return false for unchanged file', () => {
      const testFile = '/test/file.js';
      const content = 'same content';
      
      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 100
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(content);

      embeddingsIndex.addEmbedding(testFile, [1, 0, 0, 0], content);

      expect(embeddingsIndex.needsReindex(testFile)).toBe(false);
    });
  });

  describe('disk caching', () => {
    it('should save to disk when enabled', () => {
      const cachingConfig = {
        getConfig: jest.fn().mockReturnValue({
          cacheToDisk: true,
          ignorePatterns: []
        }),
        configDir: testDir
      } as any;

      const cachingIndex = new EmbeddingsIndex(cachingConfig);
      
      (fs.statSync as jest.Mock).mockReturnValue({
        mtimeMs: 123456789
      });

      cachingIndex.addEmbedding('/test/file.js', [1, 0, 0, 0], 'content');

      // Verify writeFileSync was called with cache file
      expect(fs.writeFileSync).toHaveBeenCalled();
      const calls = (fs.writeFileSync as jest.Mock).mock.calls;
      const cacheCall = calls.find(call => call[0].includes('index.json'));
      expect(cacheCall).toBeDefined();
    });
  });
});

describe('FileFilter', () => {
  let fileFilter: FileFilter;

  beforeEach(() => {
    fileFilter = new FileFilter([
      'node_modules/**',
      '*.log',
      '.git/**',
      '**/*.tmp'
    ]);
  });

  describe('shouldIndex', () => {
    it('should accept code files', () => {
      expect(fileFilter.shouldIndex('/src/index.js')).toBe(true);
      expect(fileFilter.shouldIndex('/test/spec.ts')).toBe(true);
      expect(fileFilter.shouldIndex('/lib/utils.py')).toBe(true);
      expect(fileFilter.shouldIndex('/README.md')).toBe(true);
    });

    it('should reject non-text files', () => {
      expect(fileFilter.shouldIndex('/image.png')).toBe(false);
      expect(fileFilter.shouldIndex('/video.mp4')).toBe(false);
      expect(fileFilter.shouldIndex('/data.bin')).toBe(false);
    });

    it('should respect ignore patterns', () => {
      expect(fileFilter.shouldIndex('/node_modules/package/index.js')).toBe(false);
      expect(fileFilter.shouldIndex('/app.log')).toBe(false);
      expect(fileFilter.shouldIndex('/.git/config')).toBe(false);
      expect(fileFilter.shouldIndex('/temp/file.tmp')).toBe(false);
    });

    it('should handle complex patterns', () => {
      expect(fileFilter.shouldIndex('/src/deep/nested/file.tmp')).toBe(false);
      expect(fileFilter.shouldIndex('/node_modules/pkg/src/index.js')).toBe(false);
    });
  });
});