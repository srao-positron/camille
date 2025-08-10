#!/usr/bin/env node

/**
 * Post-install script for Camille
 * Sets up hook integration with Claude Code
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

console.log('🔧 Setting up Camille...');

// Create config directory
const configDir = path.join(os.homedir(), '.camille');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
  console.log('✅ Created configuration directory');
}

// Create prompts directory
const promptsDir = path.join(configDir, 'prompts');
if (!fs.existsSync(promptsDir)) {
  fs.mkdirSync(promptsDir, { recursive: true });
  console.log('✅ Created prompts directory');
}

// Install Playwright browsers for browser automation
console.log('\n🌐 Installing browser automation support...');
try {
  execSync('npx playwright install chromium', { 
    stdio: 'inherit',
    cwd: process.cwd()
  });
  console.log('✅ Browser automation ready');
} catch (error) {
  console.warn('⚠️  Failed to install browser automation support');
  console.warn('   To enable browser automation later, run: npx playwright install chromium');
}

// Instructions for setup
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 Quick Start Guide');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n1️⃣  Set your OpenAI API key:');
console.log('   camille set-key YOUR_OPENAI_API_KEY');

console.log('\n2️⃣  Configure Claude Code hooks (for code review):');
console.log('   Add this to your Claude Code settings:');
console.log(`   {
     "hooks": {
       "preToolUse": [{
         "command": "camille hook",
         "matchers": {
           "tools": ["Edit", "MultiEdit", "Write"]
         }
       }]
     }
   }`);

console.log('\n3️⃣  Set up MCP server in Claude Code (for code search):');
console.log('   Create a .mcp.json file in your project root:');
console.log(`   
   {
     "mcpServers": {
       "camille": {
         "command": "camille",
         "args": ["server", "start", "--mcp"]
       }
     }
   }`);

console.log('\n   The MCP server will start automatically when you open the project.');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📚 For more information:');
console.log('   • Run: camille --help');
console.log('   • Visit: https://github.com/srao-positron/camille');
console.log('   • MCP docs: camille help mcp');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n✨ Setup complete!');