#!/bin/bash

# Camille MCP Pipe Proxy
# This script acts as a stdio<->named pipe proxy for MCP communication
# It forwards stdin to the named pipe and pipe responses to stdout

# Set pipe path based on platform
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    PIPE_PATH="\\\\.\\pipe\\camille-mcp"
else
    PIPE_PATH="$HOME/.camille/camille-mcp.sock"
fi

# Check if the named pipe exists
if [[ ! -e "$PIPE_PATH" ]]; then
    echo '{"error": "Camille server is not running. Please start it with: camille server start"}' >&2
    exit 1
fi

# Use netcat (nc) to connect to the Unix socket
# -U flag is for Unix domain socket
# We use a simple while loop to read from stdin and write to the pipe
if command -v nc &> /dev/null; then
    # Use netcat if available
    exec nc -U "$PIPE_PATH"
elif command -v socat &> /dev/null; then
    # Fall back to socat if available
    exec socat - UNIX-CONNECT:"$PIPE_PATH"
else
    # Simple implementation using file descriptors
    # This is less robust but works for basic cases
    exec 3<>"$PIPE_PATH"
    
    # Forward stdin to pipe and pipe to stdout
    while IFS= read -r line; do
        echo "$line" >&3
        IFS= read -r response <&3
        echo "$response"
    done
    
    # Close the pipe
    exec 3>&-
fi