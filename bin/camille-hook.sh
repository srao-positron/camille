#!/bin/bash
# Camille hook wrapper script for Claude Code
# This script provides a trusted entry point for the hook

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CAMILLE_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Set up environment
export NODE_ENV=${NODE_ENV:-production}

# Check if node is available
if ! command -v node &> /dev/null; then
    echo '{"continue": false, "decision": "block", "reason": "Node.js is not installed or not in PATH"}'
    exit 2
fi

# Check if camille CLI exists
if [ ! -f "$CAMILLE_ROOT/dist/cli.js" ]; then
    echo '{"continue": false, "decision": "block", "reason": "Camille is not built. Run npm run build first."}'
    exit 2
fi

# Debug: Log that hook was called
echo "[DEBUG] Camille hook called at $(date)" >> /tmp/camille-hook-debug.log
echo "[DEBUG] CAMILLE_ROOT: $CAMILLE_ROOT" >> /tmp/camille-hook-debug.log
echo "[DEBUG] CLI path: $CAMILLE_ROOT/dist/cli.js" >> /tmp/camille-hook-debug.log
echo "[DEBUG] Node version: $(node --version)" >> /tmp/camille-hook-debug.log

# Read stdin into a variable for debugging
STDIN_DATA=$(cat)
echo "[DEBUG] Stdin length: ${#STDIN_DATA}" >> /tmp/camille-hook-debug.log
echo "[DEBUG] First 100 chars of stdin: ${STDIN_DATA:0:100}" >> /tmp/camille-hook-debug.log

# Execute the hook command
# Pass the stdin data to the node process
echo "$STDIN_DATA" | exec node "$CAMILLE_ROOT/dist/cli.js" hook 2>> /tmp/camille-hook-debug.log