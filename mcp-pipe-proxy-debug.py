#!/usr/bin/env python3
"""
Camille MCP Pipe Proxy with Debug Logging

Enhanced version with comprehensive debug logging to diagnose connection issues.
"""

import sys
import json
import socket
import os
import platform
import time
import traceback
from datetime import datetime

# Debug log file
DEBUG_LOG = os.path.expanduser('~/.camille/mcp-proxy-debug.log')

def debug_log(message, data=None):
    """Write debug message to log file."""
    os.makedirs(os.path.dirname(DEBUG_LOG), exist_ok=True)
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    with open(DEBUG_LOG, 'a') as f:
        f.write(f"[{timestamp}] {message}\n")
        if data:
            f.write(f"  Data: {json.dumps(data, indent=2)}\n")
        f.flush()

def get_pipe_path():
    """Get the platform-specific named pipe path."""
    if platform.system() == 'Windows':
        return r'\\.\pipe\camille-mcp'
    else:
        # Use ~/.camille directory for consistency with server
        home = os.path.expanduser('~')
        return os.path.join(home, '.camille', 'camille-mcp.sock')

def send_response(response_obj):
    """Send a response object to stdout."""
    debug_log("Sending response to stdout", response_obj)
    print(json.dumps(response_obj))
    sys.stdout.flush()

def send_error(message, id=None):
    """Send an error response to stdout."""
    error = {
        "jsonrpc": "2.0",
        "error": {
            "code": -32603,
            "message": message
        },
        "id": id
    }
    debug_log(f"Sending error: {message}", error)
    send_response(error)

def forward_to_pipe(client, request):
    """Forward a request to the named pipe and return the response."""
    try:
        # Send request to pipe
        request_line = json.dumps(request) + '\n'
        debug_log("Sending to pipe", {"request": request, "bytes": len(request_line)})
        client.sendall(request_line.encode('utf-8'))
        
        # Read response
        debug_log("Waiting for response from pipe...")
        response_data = b''
        start_time = time.time()
        
        while True:
            # Add timeout check
            if time.time() - start_time > 25:  # 25 second timeout
                debug_log("Timeout waiting for response from pipe")
                raise TimeoutError("Pipe response timeout after 25 seconds")
            
            chunk = client.recv(4096)
            if not chunk:
                debug_log("Pipe connection closed (empty chunk)")
                raise ConnectionError("Pipe connection closed")
            
            debug_log(f"Received chunk from pipe", {"bytes": len(chunk), "data": chunk.decode('utf-8', errors='replace')})
            response_data += chunk
            
            # Check if we have a complete line
            if b'\n' in response_data:
                lines = response_data.split(b'\n')
                response_line = lines[0]
                
                try:
                    response = json.loads(response_line.decode('utf-8'))
                    debug_log("Parsed response from pipe", response)
                    return response
                except json.JSONDecodeError as e:
                    debug_log(f"JSON decode error: {e}", {"line": response_line.decode('utf-8', errors='replace')})
                    # Keep reading if JSON is incomplete
                    continue
                    
    except Exception as e:
        debug_log(f"Error in forward_to_pipe: {type(e).__name__}: {str(e)}", {"traceback": traceback.format_exc()})
        return {
            "jsonrpc": "2.0",
            "error": {
                "code": -32603,
                "message": f"Pipe communication error: {str(e)}"
            },
            "id": request.get('id')
        }

def main():
    """Main proxy loop."""
    debug_log("=== MCP Proxy Starting ===")
    debug_log(f"Python version: {sys.version}")
    debug_log(f"Platform: {platform.platform()}")
    
    pipe_path = get_pipe_path()
    debug_log(f"Pipe path: {pipe_path}")
    client = None
    
    try:
        while True:
            # Read a line from stdin
            debug_log("Waiting for input from stdin...")
            line = sys.stdin.readline()
            
            if not line:
                debug_log("EOF received from stdin")
                break
            
            debug_log(f"Received from stdin", {"raw": repr(line), "stripped": line.strip()})
            
            # Parse the request
            try:
                request = json.loads(line.strip())
                debug_log("Parsed request", request)
            except json.JSONDecodeError as e:
                debug_log(f"JSON decode error from stdin: {e}", {"line": repr(line)})
                send_error("Invalid JSON request")
                continue
            
            # Connect to pipe if not connected
            if not client:
                debug_log("Client not connected, attempting to connect...")
                
                # Check if the pipe exists
                if not os.path.exists(pipe_path):
                    debug_log(f"Pipe does not exist at {pipe_path}")
                    
                    # Check for permission issues
                    config_path = os.path.expanduser('~/.camille/config.json')
                    if os.path.exists(config_path):
                        try:
                            with open(config_path, 'r') as f:
                                pass
                            debug_log("Config file accessible")
                        except PermissionError as e:
                            debug_log(f"Permission error accessing config: {e}")
                            send_error("Permission denied accessing Camille config. Run: ./fix-permissions.sh", request.get('id'))
                            continue
                    else:
                        debug_log("Config file does not exist")
                    
                    send_error("Camille server is not running. Please start it with: camille server start", request.get('id'))
                    continue
                
                try:
                    # Connect to the Unix domain socket
                    debug_log("Creating socket...")
                    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    debug_log("Connecting to pipe...")
                    client.connect(pipe_path)
                    debug_log("Successfully connected to pipe")
                except Exception as e:
                    debug_log(f"Failed to connect: {type(e).__name__}: {str(e)}", {"traceback": traceback.format_exc()})
                    send_error(f"Failed to connect to Camille server: {str(e)}", request.get('id'))
                    client = None
                    continue
            
            # Forward ALL requests to pipe and get response
            debug_log("Forwarding request to pipe...")
            response = forward_to_pipe(client, request)
            debug_log("Received response, sending to stdout")
            send_response(response)
            
    except KeyboardInterrupt:
        debug_log("KeyboardInterrupt received")
        pass
    except Exception as e:
        debug_log(f"Unexpected error in main: {type(e).__name__}: {str(e)}", {"traceback": traceback.format_exc()})
        send_error(f"Proxy error: {str(e)}")
    finally:
        if client:
            debug_log("Closing client connection")
            client.close()
        debug_log("=== MCP Proxy Exiting ===")

if __name__ == '__main__':
    main()