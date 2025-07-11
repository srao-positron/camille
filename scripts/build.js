#!/usr/bin/env node

/**
 * Build script for Camille
 * Ensures proper CommonJS output
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔨 Building Camille...\n');

// Clean dist directory
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}

try {
  // Run TypeScript compiler
  console.log('Compiling TypeScript...');
  execSync('npx tsc', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  
  // Add shebang to CLI file
  const cliPath = path.join(distDir, 'cli.js');
  if (fs.existsSync(cliPath)) {
    const content = fs.readFileSync(cliPath, 'utf8');
    if (!content.startsWith('#!/usr/bin/env node')) {
      fs.writeFileSync(cliPath, '#!/usr/bin/env node\n' + content);
    }
    // Make executable
    fs.chmodSync(cliPath, '755');
  }
  
  // Copy Python MCP proxy
  const proxySource = path.join(__dirname, '..', 'mcp-pipe-proxy.py');
  const proxyDest = path.join(distDir, 'mcp-pipe-proxy.py');
  if (fs.existsSync(proxySource)) {
    fs.copyFileSync(proxySource, proxyDest);
    fs.chmodSync(proxyDest, '755');
    console.log('Copied MCP proxy script');
  }
  
  // Copy bin directory with hook script
  const binSource = path.join(__dirname, '..', 'bin');
  const binDest = path.join(distDir, '..', 'bin');
  if (fs.existsSync(binSource)) {
    if (!fs.existsSync(binDest)) {
      fs.mkdirSync(binDest, { recursive: true });
    }
    const files = fs.readdirSync(binSource);
    files.forEach(file => {
      const src = path.join(binSource, file);
      const dest = path.join(binDest, file);
      fs.copyFileSync(src, dest);
      // Make shell scripts executable
      if (file.endsWith('.sh')) {
        fs.chmodSync(dest, '755');
      }
    });
    console.log('Copied bin directory');
  }
  
  console.log('\n✅ Build completed successfully!');
  
} catch (error) {
  console.error('\n❌ Build failed:', error.message);
  process.exit(1);
}