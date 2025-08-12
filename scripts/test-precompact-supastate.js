#!/usr/bin/env node

/**
 * Test script to verify pre-compact hook works with Supastate
 */

const { PreCompactHook } = require('./dist/memory/hooks/precompact-hook.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function test() {
  // Create a test transcript
  const testDir = path.join(os.tmpdir(), 'camille-precompact-test');
  fs.mkdirSync(testDir, { recursive: true });
  
  const transcriptPath = path.join(testDir, 'test-transcript.jsonl');
  
  // Write some test messages
  const messages = [
    {
      type: 'human',
      timestamp: new Date().toISOString(),
      sessionId: 'test-session-' + Date.now(),
      uuid: 'msg-1',
      message: {
        type: 'message',
        role: 'human',
        content: [{ type: 'text', text: 'This is a test message for Supastate pre-compact hook integration.' }]
      },
      cwd: process.cwd()
    },
    {
      type: 'assistant',
      timestamp: new Date(Date.now() + 1000).toISOString(),
      sessionId: 'test-session-' + Date.now(),
      uuid: 'msg-2',
      parentUuid: 'msg-1',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'I understand. This is a test response to verify the integration is working correctly.' }]
      }
    }
  ];
  
  fs.writeFileSync(transcriptPath, messages.map(m => JSON.stringify(m)).join('\n'));
  
  console.log('Created test transcript at:', transcriptPath);
  console.log('Running pre-compact hook...\n');
  
  // Create hook input
  const hookInput = {
    session_id: 'test-session-' + Date.now(),
    transcript_path: transcriptPath,
    hook_event_name: 'PreCompact',
    trigger: 'test',
    project_path: process.cwd(),
    compaction_reason: 'manual'
  };
  
  // Run the hook
  const hook = new PreCompactHook();
  
  try {
    await hook.run(hookInput);
    console.log('\n✅ Pre-compact hook completed successfully!');
  } catch (error) {
    console.error('\n❌ Pre-compact hook failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
  
  // Clean up
  fs.rmSync(testDir, { recursive: true, force: true });
}

test().catch(console.error);