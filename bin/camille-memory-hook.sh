#!/bin/bash

# Shell wrapper for Camille memory hook
# This script is called by Claude Code as a PreCompact hook

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Check if we're in development (script is in bin/)
if [ -f "$SCRIPT_DIR/../dist/cli.js" ]; then
    # Development mode - use local installation
    NODE_SCRIPT="$SCRIPT_DIR/../dist/cli.js"
else
    # Production mode - use global installation
    NODE_SCRIPT="$(which camille)"
    if [ -z "$NODE_SCRIPT" ]; then
        echo "Error: camille command not found in PATH" >&2
        exit 2
    fi
fi

# Run the memory hook command, passing stdin through
exec node "$NODE_SCRIPT" memory-hook