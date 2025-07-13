/**
 * Tests for PreCompact hook
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PreCompactHook } from '../../src/memory/hooks/precompact-hook';

// Mock the logger
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('PreCompact Hook', () => {
  let hook: PreCompactHook;
  let testDir: string;
  let mockTranscriptPath: string;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let processExitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(async () => {
    // Create test directory
    testDir = path.join(os.tmpdir(), 'camille-test-hook-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    // Set test config directory
    process.env.CAMILLE_CONFIG_DIR = testDir;
    
    // Create mock transcript file
    mockTranscriptPath = path.join(testDir, 'transcript.jsonl');
    
    // Mock console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Process exit called');
    });
    
    hook = new PreCompactHook();
  });

  afterEach(async () => {
    // Restore mocks
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Clear environment
    delete process.env.CAMILLE_CONFIG_DIR;
  });

  const createMockTranscript = async (messages: any[]) => {
    const content = messages.map(msg => JSON.stringify(msg)).join('\n');
    await fs.writeFile(mockTranscriptPath, content);
  };

  const createMockConfig = async (memoryEnabled: boolean = true) => {
    const configPath = path.join(testDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      openaiApiKey: 'test-key',
      memory: {
        enabled: memoryEnabled,
        transcript: {
          enabled: true
        }
      }
    }));
  };

  describe('Input validation', () => {
    it('should handle valid PreCompact input', async () => {
      await createMockConfig();
      await createMockTranscript([
        {
          timestamp: '2024-01-01T00:00:00Z',
          role: 'human',
          content: 'Hello'
        }
      ]);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        project_path: '/test/project',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      // Should output success
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('success');
      expect(parsed.stats).toBeDefined();
    });

    it('should skip processing when memory is disabled', async () => {
      await createMockConfig(false);
      await createMockTranscript([]);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      // Should not process anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('Transcript processing', () => {
    beforeEach(async () => {
      await createMockConfig();
    });

    it('should read and parse JSONL transcript', async () => {
      const messages = [
        {
          timestamp: '2024-01-01T00:00:00Z',
          role: 'human',
          content: 'What is TypeScript?'
        },
        {
          timestamp: '2024-01-01T00:00:10Z',
          role: 'assistant',
          content: 'TypeScript is a typed superset of JavaScript.'
        }
      ];

      await createMockTranscript(messages);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.messages_processed).toBe(2);
    });

    it('should handle malformed JSON lines gracefully', async () => {
      await fs.writeFile(mockTranscriptPath, `
{"timestamp": "2024-01-01T00:00:00Z", "role": "human", "content": "Valid"}
invalid json line
{"timestamp": "2024-01-01T00:00:10Z", "role": "assistant", "content": "Also valid"}
`);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.messages_processed).toBe(2); // Should process valid lines
    });

    it('should handle empty transcript', async () => {
      await createMockTranscript([]);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'time' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.messages_processed).toBe(0);
      expect(output.stats.chunks_created).toBe(0);
    });

    it('should handle missing transcript file', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/non/existent/file.jsonl',
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'manual' as const
      };

      await expect(hook.run(input)).rejects.toThrow('Process exit called');
      expect(processExitSpy).toHaveBeenCalledWith(2);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Chunking logic', () => {
    beforeEach(async () => {
      await createMockConfig();
    });

    it('should create chunks based on size', async () => {
      // Create a long conversation
      const messages = [];
      for (let i = 0; i < 20; i++) {
        messages.push({
          timestamp: `2024-01-01T00:${i.toString().padStart(2, '0')}:00Z`,
          role: i % 2 === 0 ? 'human' : 'assistant',
          content: 'This is a message with some content. '.repeat(50) // ~350 characters
        });
      }

      await createMockTranscript(messages);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.chunks_created).toBeGreaterThan(1);
      expect(output.stats.chunks_created).toBeLessThan(20);
    });

    it('should detect topic boundaries', async () => {
      const messages = [
        {
          timestamp: '2024-01-01T00:00:00Z',
          role: 'human',
          content: 'Tell me about JavaScript'
        },
        {
          timestamp: '2024-01-01T00:00:10Z',
          role: 'assistant',
          content: 'JavaScript is a programming language...'
        },
        {
          timestamp: '2024-01-01T00:00:20Z',
          role: 'human',
          content: "Now let's talk about Python"  // Topic change marker
        },
        {
          timestamp: '2024-01-01T00:00:30Z',
          role: 'assistant',
          content: 'Python is a different language...'
        }
      ];

      await createMockTranscript(messages);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.chunks_created).toBe(2); // Should create 2 chunks due to topic change
    });

    it('should detect time gaps as boundaries', async () => {
      const messages = [
        {
          timestamp: '2024-01-01T00:00:00Z',
          role: 'human',
          content: 'First topic'
        },
        {
          timestamp: '2024-01-01T00:00:10Z',
          role: 'assistant',
          content: 'Response to first topic'
        },
        {
          timestamp: '2024-01-01T00:10:00Z',  // 10 minute gap
          role: 'human',
          content: 'Different topic after break'
        },
        {
          timestamp: '2024-01-01T00:10:10Z',
          role: 'assistant',
          content: 'Response to different topic'
        }
      ];

      await createMockTranscript(messages);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await hook.run(input);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.stats.chunks_created).toBe(2); // Should create 2 chunks due to time gap
    });
  });

  describe('Incremental processing', () => {
    beforeEach(async () => {
      await createMockConfig();
    });

    it('should process only new messages on second run', async () => {
      const initialMessages = [
        {
          timestamp: '2024-01-01T00:00:00Z',
          role: 'human',
          content: 'Initial message'
        },
        {
          timestamp: '2024-01-01T00:00:10Z',
          role: 'assistant',
          content: 'Initial response'
        }
      ];

      await createMockTranscript(initialMessages);

      const input = {
        session_id: 'test-session',
        transcript_path: mockTranscriptPath,
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      // First run
      await hook.run(input);
      
      const firstOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(firstOutput.stats.messages_processed).toBe(2);

      // Add more messages
      const allMessages = [
        ...initialMessages,
        {
          timestamp: '2024-01-01T00:00:20Z',
          role: 'human',
          content: 'New message'
        },
        {
          timestamp: '2024-01-01T00:00:30Z',
          role: 'assistant',
          content: 'New response'
        }
      ];

      await createMockTranscript(allMessages);

      // Clear console mock
      consoleLogSpy.mockClear();

      // Second run - should only process new messages
      const hook2 = new PreCompactHook();
      await hook2.run(input);

      const secondOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(secondOutput.stats.messages_processed).toBe(2); // Only new messages
    });
  });

  describe('Error handling', () => {
    it('should exit with code 2 on critical errors', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/permission/denied/path.jsonl',
        hook_event_name: 'PreCompact' as const,
        trigger: 'test',
        compaction_reason: 'size' as const
      };

      await expect(hook.run(input)).rejects.toThrow('Process exit called');
      expect(processExitSpy).toHaveBeenCalledWith(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process transcript')
      );
    });
  });
});