#!/bin/bash

# Test script for Supastate setup flow
echo "Testing Supastate setup flow..."

# Check if the build exists
if [ ! -f "dist/cli.js" ]; then
    echo "Error: Build not found. Run 'npm run build' first."
    exit 1
fi

# Remove existing config to ensure fresh setup
rm -f ~/.camille/config.json

# Test that the setup command exists and shows the Supastate prompt
echo "Testing setup command..."
echo "n" | node dist/cli.js setup 2>&1 | grep -q "Are you a Supastate user?"

if [ $? -eq 0 ]; then
    echo "✅ Supastate prompt appears in setup"
else
    echo "❌ Supastate prompt not found in setup"
    exit 1
fi

echo "✅ All tests passed!"