#!/usr/bin/env python3
"""
Camille MCP Pipe Proxy with comprehensive logging

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
import datetime
import traceback
import time

# Log file for proxy debugging
LOG_FILE = '/tmp/camille-proxy.log'

# Reconnection settings
MAX_RECONNECT_ATTEMPTS = 5
INITIAL_RECONNECT_DELAY = 0.5  # seconds
MAX_RECONNECT_DELAY = 10.0  # seconds

def log(message, data=None):
    """Write timestamped log entry to file."""
    timestamp = datetime.datetime.now().isoformat()
    with open(LOG_FILE, 'a') as f:
        f.write(f"[{timestamp}] {message}\n")
        if data:
            f.write(f"  Data: {json.dumps(data, indent=2)}\n")
        f.flush()

def get_pipe_path():
    """Get the platform-specific named pipe path."""
    if platform.system() == 'Windows':
        return r'\\.\pipe\camille-mcp'
    else:
        # Use ~/.camille directory for consistency
        home = os.path.expanduser('~')
        return os.path.join(home, '.camille', 'camille-mcp.sock')

def send_response(response_obj):
    """Send a response object to stdout."""
    # Special debug for tools/list
    if (isinstance(response_obj, dict) and 
        response_obj.get('result', {}).get('tools') is not None):
        tools = response_obj['result']['tools']
        log(f"TOOLS/LIST RESPONSE: {len(tools)} tools", {
            'tool_names': [t.get('name', 'unknown') for t in tools]
        })
    
    response_str = json.dumps(response_obj)
    log(f"SENDING RESPONSE TO CLAUDE CODE", response_obj)
    print(response_str)
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
    log(f"SENDING ERROR TO CLAUDE CODE: {message}", error)
    send_response(error)

def connect_to_pipe(pipe_path, timeout=5.0):
    """Connect to the named pipe with timeout."""
    try:
        log(f"CONNECTING TO UNIX SOCKET: {pipe_path}")
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(timeout)
        client.connect(pipe_path)
        log("CONNECTED TO PIPE SUCCESSFULLY")
        return client
    except Exception as e:
        log(f"PIPE CONNECTION ERROR: {str(e)}", {"traceback": traceback.format_exc()})
        return None

def forward_to_pipe(client, request):
    """Forward a request to the named pipe and return the response."""
    try:
        # Send request to pipe
        request_line = json.dumps(request) + '\n'
        log(f"FORWARDING TO PIPE", request)
        client.sendall(request_line.encode('utf-8'))
        log(f"SENT TO PIPE: {len(request_line)} bytes")
        
        # Read response with timeout
        client.settimeout(30.0)  # 30 second timeout for response
        response_data = b''
        chunks_received = 0
        
        while True:
            try:
                chunk = client.recv(4096)
                chunks_received += 1
                
                if not chunk:
                    log(f"PIPE CLOSED after {chunks_received} chunks")
                    raise ConnectionError("Pipe connection closed")
                
                response_data += chunk
                log(f"RECEIVED CHUNK {chunks_received}: {len(chunk)} bytes, total: {len(response_data)} bytes")
                
                # Check if we have a complete line
                if b'\n' in response_data:
                    lines = response_data.split(b'\n')
                    response_line = lines[0]
                    
                    try:
                        response = json.loads(response_line.decode('utf-8'))
                        log(f"PARSED RESPONSE FROM PIPE", response)
                        return response
                    except json.JSONDecodeError as e:
                        log(f"JSON DECODE ERROR: {e}, line: {response_line[:100]}")
                        # Keep reading if JSON is incomplete
                        continue
                        
            except socket.timeout:
                log("SOCKET TIMEOUT while reading response")
                raise ConnectionError("Timeout waiting for response from Camille server")
                
    except Exception as e:
        log(f"PIPE ERROR: {str(e)}", {"traceback": traceback.format_exc()})
        raise

def reconnect_with_backoff(pipe_path, attempt=0):
    """Attempt to reconnect with exponential backoff."""
    if attempt >= MAX_RECONNECT_ATTEMPTS:
        log(f"MAX RECONNECTION ATTEMPTS ({MAX_RECONNECT_ATTEMPTS}) REACHED")
        return None
    
    if attempt > 0:
        delay = min(INITIAL_RECONNECT_DELAY * (2 ** (attempt - 1)), MAX_RECONNECT_DELAY)
        log(f"WAITING {delay:.1f}s BEFORE RECONNECT ATTEMPT #{attempt + 1}")
        time.sleep(delay)
    
    client = connect_to_pipe(pipe_path)
    if client:
        return client
    
    # Recursive retry with increased attempt count
    return reconnect_with_backoff(pipe_path, attempt + 1)

def main():
    """Main proxy loop."""
    log("=== PROXY STARTED ===")
    log(f"Python version: {sys.version}")
    log(f"Arguments: {sys.argv}")
    
    pipe_path = get_pipe_path()
    log(f"Pipe path: {pipe_path}")
    
    client = None
    request_count = 0
    
    try:
        log("WAITING FOR INPUT FROM CLAUDE CODE...")
        while True:
            # Read a line from stdin
            line = sys.stdin.readline()
            if not line:
                log("EOF RECEIVED FROM CLAUDE CODE")
                break
            
            request_count += 1
            log(f"=== REQUEST #{request_count} ===")
            log(f"RAW INPUT: {line.strip()[:200]}...")
            
            # Parse the request
            try:
                request = json.loads(line.strip())
                log(f"PARSED REQUEST", request)
            except json.JSONDecodeError as e:
                log(f"JSON PARSE ERROR: {e}")
                send_error("Invalid JSON request")
                continue
            
            # Check if the pipe exists
            if not os.path.exists(pipe_path):
                log(f"PIPE DOES NOT EXIST: {pipe_path}")
                
                # Check for permission issues
                config_path = os.path.expanduser('~/.camille/config.json')
                if os.path.exists(config_path):
                    try:
                        with open(config_path, 'r') as f:
                            pass
                        log("Config file is readable")
                    except PermissionError:
                        log("PERMISSION ERROR on config file")
                        send_error("Permission denied accessing Camille config. Run: ./fix-permissions.sh", request.get('id'))
                        continue
                
                send_error("Camille server is not running. Please start it with: camille server start", request.get('id'))
                continue
            
            # Handle notification
            if 'id' not in request:
                log(f"NOTIFICATION DETECTED (no id): {request.get('method')}")
                if not client:
                    client = reconnect_with_backoff(pipe_path)
                if client:
                    try:
                        request_line = json.dumps(request) + '\n'
                        client.sendall(request_line.encode('utf-8'))
                        log(f"NOTIFICATION SENT, NOT WAITING FOR RESPONSE")
                    except Exception as e:
                        log(f"FAILED TO SEND NOTIFICATION: {str(e)}")
                        client = None
                continue
            
            # Handle regular request with reconnection logic
            reconnect_attempts = 0
            response = None
            
            while reconnect_attempts < MAX_RECONNECT_ATTEMPTS:
                if not client:
                    log(f"CLIENT NOT CONNECTED, ATTEMPTING RECONNECTION (attempt {reconnect_attempts + 1}/{MAX_RECONNECT_ATTEMPTS})")
                    client = reconnect_with_backoff(pipe_path, reconnect_attempts)
                    if not client:
                        reconnect_attempts += 1
                        continue
                
                try:
                    log(f"FORWARDING REQUEST: {request.get('method')}")
                    response = forward_to_pipe(client, request)
                    break  # Success, exit retry loop
                except Exception as e:
                    log(f"REQUEST FAILED: {str(e)}")
                    # Close the broken connection
                    if client:
                        try:
                            client.close()
                        except:
                            pass
                        client = None
                    reconnect_attempts += 1
            
            # Send response or error
            if response:
                send_response(response)
            else:
                send_error(f"Failed to communicate with Camille server after {MAX_RECONNECT_ATTEMPTS} attempts", request.get('id'))
            
    except KeyboardInterrupt:
        log("KEYBOARD INTERRUPT")
    except Exception as e:
        log(f"UNEXPECTED ERROR: {str(e)}", {"traceback": traceback.format_exc()})
        send_error(f"Proxy error: {str(e)}")
    finally:
        log("CLEANING UP...")
        if client:
            try:
                client.close()
                log("PIPE CONNECTION CLOSED")
            except:
                pass
        log("=== PROXY EXITED ===\n\n")

if __name__ == '__main__':
    main()