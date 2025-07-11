/**
 * Tests for Claude Code hook functionality
 */

import { CamilleHook } from '../src/hook';
import { ConfigManager } from '../src/config';
import { LLMClient } from '../src/llm-client';
import * as fs from 'fs';
import * as path from 'path';

// Mock the LLM client
jest.mock('../src/llm-client');

describe('CamilleHook', () => {
  let hook: CamilleHook;
  let mockLLMClient: jest.Mocked<LLMClient>;
  
  beforeEach(() => {
    // Mock config manager to provide test API key
    jest.spyOn(ConfigManager.prototype, 'getApiKey').mockReturnValue('test-api-key');
    jest.spyOn(ConfigManager.prototype, 'getConfig').mockReturnValue({
      provider: 'openai',
      openaiApiKey: 'test-api-key',
      models: {
        review: 'gpt-4-turbo-preview',
        quick: 'gpt-4o-mini',
        embedding: 'text-embedding-3-small'
      },
      temperature: 0.1,
      maxTokens: 4000,
      cacheToDisk: false,
      ignorePatterns: []
    } as any);

    // Mock LLM client
    mockLLMClient = {
      reviewCode: jest.fn(),
      comprehensiveReview: jest.fn()
    } as any;
    
    (LLMClient as jest.MockedClass<typeof LLMClient>).mockImplementation(() => mockLLMClient);
    
    hook = new CamilleHook();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('processHook', () => {
    it('should approve code with no issues', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Edit',
          input: {
            file_path: '/test/file.js',
            old_string: 'console.log("test")',
            new_string: 'logger.info("test")'
          }
        }
      };

      mockLLMClient.reviewCode.mockResolvedValue({
        securityIssues: [],
        complianceViolations: [],
        codeQualityIssues: [],
        suggestions: ['Consider using structured logging'],
        approvalStatus: 'APPROVED',
        rawResponse: 'Code looks good'
      });

      const result = await hook.processHook(input);

      expect(result.continue).toBe(true);
      expect(result.decision).toBe('approve');
      expect(result.reason).toContain('Code review passed');
    });

    it('should block code with security issues', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Write',
          input: {
            file_path: '/test/vulnerable.js',
            content: 'eval(userInput)'
          }
        }
      };

      mockLLMClient.reviewCode.mockResolvedValue({
        securityIssues: ['Potential code injection via eval()'],
        complianceViolations: [],
        codeQualityIssues: [],
        suggestions: ['Use JSON.parse() instead of eval()'],
        approvalStatus: 'REQUIRES_SECURITY_REVIEW',
        rawResponse: 'Security issue detected'
      });

      const result = await hook.processHook(input);

      expect(result.continue).toBe(false);
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('SECURITY REVIEW REQUIRED');
      expect(result.reason).toContain('code injection');
    });

    it('should block code with compliance violations', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'MultiEdit',
          input: {
            file_path: '/test/file.js',
            edits: [
              { old_string: 'async function', new_string: 'function' }
            ]
          }
        }
      };

      mockLLMClient.reviewCode.mockResolvedValue({
        securityIssues: [],
        complianceViolations: ['Removing async violates project async/await requirements'],
        codeQualityIssues: ['Potential race condition'],
        suggestions: [],
        approvalStatus: 'NEEDS_CHANGES',
        rawResponse: 'Compliance issue detected'
      });

      const result = await hook.processHook(input);

      expect(result.continue).toBe(false);
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('Removing async violates');
    });

    it('should pass through non-code editing tools', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Read',
          input: { file_path: '/test/file.js' }
        }
      };

      const result = await hook.processHook(input);

      expect(result.continue).toBe(true);
      expect(mockLLMClient.reviewCode).not.toHaveBeenCalled();
    });

    it('should pass through non-PreToolUse events', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PostToolUse',
        tool: {
          name: 'Edit',
          input: { file_path: '/test/file.js' }
        }
      };

      const result = await hook.processHook(input);

      expect(result.continue).toBe(true);
      expect(mockLLMClient.reviewCode).not.toHaveBeenCalled();
    });

    it('should handle OpenAI API errors', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Edit',
          input: {
            file_path: '/test/file.js',
            old_string: 'test',
            new_string: 'test2'
          }
        }
      };

      mockLLMClient.reviewCode.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await hook.processHook(input);

      expect(result.continue).toBe(false);
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('API rate limit exceeded');
    });
  });

  describe('code change formatting', () => {
    it('should format Edit changes correctly', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'Edit',
          input: {
            file_path: '/test/file.js',
            old_string: 'const a = 1',
            new_string: 'const a = 2'
          }
        }
      };

      mockLLMClient.reviewCode.mockImplementation(async (system: any, user: any, detailed: any) => {
        expect(user).toContain('File: /test/file.js');
        expect(user).toContain('Action: Edit');
        expect(user).toContain('Old: const a = 1');
        expect(user).toContain('New: const a = 2');
        
        return {
          securityIssues: [],
          complianceViolations: [],
          codeQualityIssues: [],
          suggestions: [],
          approvalStatus: 'APPROVED',
          rawResponse: 'OK'
        };
      });

      await hook.processHook(input);
      expect(mockLLMClient.reviewCode).toHaveBeenCalled();
    });

    it('should format MultiEdit changes correctly', async () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        hook_event_name: 'PreToolUse',
        tool: {
          name: 'MultiEdit',
          input: {
            file_path: '/test/file.js',
            edits: [
              { old_string: 'a', new_string: 'b' },
              { old_string: 'c', new_string: 'd' }
            ]
          }
        }
      };

      mockLLMClient.reviewCode.mockImplementation(async (system: any, user: any, detailed: any) => {
        expect(user).toContain('File: /test/file.js');
        expect(user).toContain('Action: MultiEdit');
        expect(user).toContain('Edit 1:');
        expect(user).toContain('Old: a');
        expect(user).toContain('New: b');
        expect(user).toContain('Edit 2:');
        
        return {
          securityIssues: [],
          complianceViolations: [],
          codeQualityIssues: [],
          suggestions: [],
          approvalStatus: 'APPROVED',
          rawResponse: 'OK'
        };
      });

      await hook.processHook(input);
      expect(mockLLMClient.reviewCode).toHaveBeenCalled();
    });
  });
});