/**
 * Test pre-compact hook with direct Supastate integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PreCompactHook } from '../../src/memory/hooks/precompact-hook.js';
import { ConfigManager } from '../../src/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('../../src/config.js');
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}));
vi.mock('node-fetch');

describe('PreCompactHook with Supastate', () => {
  let hook: PreCompactHook;
  let mockConfigManager: any;
  let testTranscriptPath: string;
  
  beforeEach(async () => {
    // Create test transcript file
    const testDir = path.join(os.tmpdir(), 'camille-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    testTranscriptPath = path.join(testDir, 'transcript.jsonl');
    
    // Write test transcript data
    const transcriptData = [
      {
        type: 'human',
        timestamp: '2024-01-01T10:00:00Z',
        sessionId: 'test-session',
        uuid: 'msg-1',
        message: {
          type: 'message',
          role: 'human',
          content: [{ type: 'text', text: 'Hello, can you help me with my code?' }]
        },
        cwd: '/test/project'
      },
      {
        type: 'assistant',
        timestamp: '2024-01-01T10:00:30Z',
        sessionId: 'test-session',
        uuid: 'msg-2',
        parentUuid: 'msg-1',
        message: {
          type: 'message',
          role: 'assistant',
          model: 'claude-3-opus',
          content: [{ type: 'text', text: 'Of course! What would you like help with?' }]
        }
      }
    ];
    
    await fs.writeFile(
      testTranscriptPath,
      transcriptData.map(d => JSON.stringify(d)).join('\n')
    );
    
    // Mock ConfigManager
    mockConfigManager = {
      getConfig: vi.fn(),
      updateConfig: vi.fn()
    };
    
    (ConfigManager as any).mockImplementation(() => mockConfigManager);
    
    hook = new PreCompactHook();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  it('should use direct Supastate ingestion when configured', async () => {
    // Configure with Supastate enabled
    mockConfigManager.getConfig.mockReturnValue({
      memory: {
        enabled: true,
        transcript: { enabled: true },
        indexing: {
          chunkSize: 2000,
          chunkOverlap: 100
        }
      },
      supastate: {
        enabled: true,
        url: 'https://service.supastate.ai',
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      }
    });
    
    // Mock successful Supastate response
    const mockFetch = fetch as any;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ processed: 1, status: 'success' })
    });
    
    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Run the hook
    await hook.run({
      session_id: 'test-session',
      transcript_path: testTranscriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'test',
      compaction_reason: 'manual'
    });
    
    // Verify Supastate was called
    expect(mockFetch).toHaveBeenCalledWith(
      'https://service.supastate.ai/functions/v1/ingest-memory',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-access-token',
          'Content-Type': 'application/json'
        }),
        body: expect.stringContaining('"projectName":"project"')
      })
    );
    
    // Verify success output
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"status":"success"')
    );
    
    consoleSpy.mockRestore();
  });
  
  it('should refresh token when expired', async () => {
    // Configure with expired token
    mockConfigManager.getConfig.mockReturnValue({
      memory: {
        enabled: true,
        transcript: { enabled: true }
      },
      supastate: {
        enabled: true,
        url: 'https://service.supastate.ai',
        accessToken: 'old-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) - 100, // Expired
        supabaseUrl: 'https://pkwzimgcvjqhsbkmdlec.supabase.co',
        supabaseAnonKey: 'test-anon-key'
      }
    });
    
    const mockFetch = fetch as any;
    
    // Mock token refresh response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      })
    });
    
    // Mock successful ingestion response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ processed: 1, status: 'success' })
    });
    
    // Run the hook
    await hook.run({
      session_id: 'test-session',
      transcript_path: testTranscriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'test',
      compaction_reason: 'manual'
    });
    
    // Verify token refresh was called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/v1/token?grant_type=refresh_token'),
      expect.objectContaining({
        method: 'POST'
      })
    );
    
    // Verify ingestion used new token
    expect(mockFetch).toHaveBeenCalledWith(
      'https://service.supastate.ai/functions/v1/ingest-memory',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer new-access-token'
        })
      })
    );
    
    // Verify config was updated
    expect(mockConfigManager.updateConfig).toHaveBeenCalledWith({
      supastate: expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token'
      })
    });
  });
  
  it('should fall back to Camille server when Supastate not configured', async () => {
    // Configure without Supastate
    mockConfigManager.getConfig.mockReturnValue({
      memory: {
        enabled: true,
        transcript: { enabled: true }
      },
      supastate: {
        enabled: false
      }
    });
    
    // Create mock TranscriptProcessor
    const TranscriptProcessor = vi.fn().mockImplementation(() => ({
      processMessages: vi.fn().mockResolvedValue({
        chunks: 1,
        embeddings: 1
      })
    }));
    
    // Replace the import
    vi.doMock('../../src/memory/processors/transcript-processor.js', () => ({
      TranscriptProcessor
    }));
    
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Run the hook
    await hook.run({
      session_id: 'test-session',
      transcript_path: testTranscriptPath,
      hook_event_name: 'PreCompact',
      trigger: 'test',
      compaction_reason: 'manual'
    });
    
    // Verify Supastate was NOT called
    expect(fetch).not.toHaveBeenCalled();
    
    // Verify success output (from regular processing)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"status":"success"')
    );
    
    consoleSpy.mockRestore();
  });
});