#!/usr/bin/env python3
"""
Camille MCP Pipe Proxy

This script acts as a bridge between Claude Code's stdio-based MCP protocol
and Camille's named pipe server. It forwards MCP requests from stdin to the
named pipe and sends responses back to stdout.

The named pipe protocol is simple:
1. Send a JSON-encoded request line to the pipe
2. Read a JSON-encoded response line from the pipe

Users can extend this script to add custom logic, logging, or transformations.
"""

import sys
import json
import socket
import os
import platform

def get_pipe_path():
    """Get the platform-specific named pipe path."""
    if platform.system() == 'Windows':
        return r'\\.\pipe\camille-mcp'
    else:
        return '/tmp/camille-mcp.sock'

def send_error(message):
    """Send an error response to stdout."""
    error = {
        "jsonrpc": "2.0",
        "error": {
            "code": -32603,
            "message": message
        },
        "id": None
    }
    print(json.dumps(error))
    sys.stdout.flush()

def main():
    """Main proxy loop."""
    pipe_path = get_pipe_path()
    
    # Check if the pipe exists
    if not os.path.exists(pipe_path):
        send_error("Camille server is not running. Please start it with: camille server start")
        sys.exit(1)
    
    try:
        # Connect to the Unix domain socket
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(pipe_path)
        
        # Main proxy loop
        while True:
            try:
                # Read a line from stdin
                line = sys.stdin.readline()
                if not line:
                    break
                
                # Optional: Add custom request processing here
                # For example, you could log requests, add authentication,
                # or transform the request before forwarding
                
                # Send to the named pipe
                client.sendall(line.encode('utf-8'))
                
                # Read response from the pipe
                # We need to read until we get a complete JSON response
                response_data = b''
                while True:
                    chunk = client.recv(4096)
                    if not chunk:
                        break
                    response_data += chunk
                    
                    # Try to parse as JSON to see if we have a complete response
                    try:
                        response = json.loads(response_data.decode('utf-8'))
                        # Optional: Add custom response processing here
                        # For example, you could log responses or transform them
                        
                        # Send to stdout
                        print(json.dumps(response))
                        sys.stdout.flush()
                        break
                    except json.JSONDecodeError:
                        # Not a complete JSON yet, keep reading
                        continue
                    
            except (IOError, OSError) as e:
                send_error(f"Pipe communication error: {str(e)}")
                break
                
    except (socket.error, OSError) as e:
        send_error(f"Failed to connect to Camille server: {str(e)}")
        sys.exit(1)
    finally:
        if 'client' in locals():
            client.close()

if __name__ == '__main__':
    main()