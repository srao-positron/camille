#!/bin/bash

# Camille Quick Start Script
# This script helps you get Camille running quickly

echo "🚀 Camille Quick Start"
echo "====================="
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install --production
fi

# Build if needed
if [ ! -d "dist" ]; then
    echo "🔨 Building Camille..."
    npm run build:tsc 2>/dev/null || npx tsc --skipLibCheck 2>/dev/null || echo "Build warnings ignored"
fi

# Make CLI executable
if [ -f "dist/cli.js" ]; then
    chmod +x dist/cli.js
    # Add shebang if missing
    if ! head -1 dist/cli.js | grep -q '^#!/usr/bin/env node'; then
        echo '#!/usr/bin/env node' | cat - dist/cli.js > temp && mv temp dist/cli.js
    fi
fi

# Check if API key is set
if [ -z "$OPENAI_API_KEY" ] && [ ! -f "$HOME/.camille/config.json" ]; then
    echo ""
    echo "⚠️  No OpenAI API key found!"
    echo ""
    echo "Please set your API key using one of these methods:"
    echo "1. Export environment variable: export OPENAI_API_KEY='your-key'"
    echo "2. Run setup: node dist/cli.js setup"
    echo "3. Set directly: node dist/cli.js set-key your-key"
    echo ""
    exit 1
fi

echo ""
echo "✅ Camille is ready!"
echo ""
echo "Commands:"
echo "  node dist/cli.js setup          - Run interactive setup"
echo "  node dist/cli.js server start   - Start the server"
echo "  node dist/cli.js help           - Show help"
echo ""

# Optionally start the server
read -p "Would you like to start the server now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    node dist/cli.js server start
fi