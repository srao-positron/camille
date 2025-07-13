# Memory System Installation Guide

## Dependencies to Install

To set up the Camille memory system, you'll need to install the following dependencies:

```bash
# Vector database for semantic search
npm install lancedb

# Graph database for code relationships
npm install kuzu

# mDNS/Bonjour for peer discovery
npm install bonjour @types/bonjour

# Certificate generation for HTTPS
npm install node-forge @types/node-forge

# Additional utilities
npm install lru-cache
```

## Installation Steps

1. **Fix npm permissions if needed**:
   ```bash
   sudo chown -R $(id -u):$(id -g) ~/.npm
   ```

2. **Install dependencies**:
   ```bash
   cd /path/to/camille
   npm install lancedb kuzu bonjour node-forge lru-cache
   npm install --save-dev @types/bonjour @types/node-forge
   ```

3. **Create memory directories**:
   ```bash
   mkdir -p ~/.camille/memory/{vectors,graph,sqlite}
   mkdir -p ~/.camille/memory/vectors/{transcripts,code,metadata}
   mkdir -p ~/.camille/memory/graph/{schema,data}
   ```

4. **Update package.json** (already done in the main package.json)

## Troubleshooting

### npm Permission Errors
If you encounter permission errors with npm:
```bash
# Option 1: Fix npm cache permissions
sudo chown -R $(id -u):$(id -g) ~/.npm

# Option 2: Use a different npm prefix
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

### LanceDB Installation Issues
LanceDB requires native bindings. If installation fails:
```bash
# Ensure you have build tools installed
# macOS:
xcode-select --install

# Linux:
sudo apt-get install build-essential
```

### Kuzu Installation Issues
Kuzu also requires native bindings:
```bash
# The package will download prebuilt binaries for most platforms
# If it fails, ensure your Node.js version is >=18
node --version
```

## Verification

After installation, verify the setup:

```typescript
// Test LanceDB
import * as lancedb from 'lancedb';
const db = await lancedb.connect('~/.camille/memory/vectors');
console.log('LanceDB connected successfully');

// Test Kuzu
import * as kuzu from 'kuzu';
const kuzuDb = new kuzu.Database('~/.camille/memory/graph');
console.log('Kuzu connected successfully');

// Test Bonjour
import * as bonjour from 'bonjour';
const mdns = bonjour();
console.log('Bonjour initialized successfully');
```

## Next Steps

1. Implement the database abstraction layers in `src/memory/databases/`
2. Create the PreCompact hook in `src/memory/hooks/`
3. Build the peer-to-peer network in `src/memory/network/`
4. Implement MCP tools in `src/memory/tools/`