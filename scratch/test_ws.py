import urllib.request
import re
import asyncio
import websockets
import json

async def test_ws():
    # 1. Fetch the index page to get the token
    url = "http://127.0.0.1:9876/"
    print(f"Fetching token from {url}...")
    try:
        with urllib.request.urlopen(url) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch token from HTTP server: {e}")
        return

    # Extract AUTH_TOKEN
    token_match = re.search(r'window\.AUTH_TOKEN\s*=\s*"([^"]+)"', html)
    session_match = re.search(r'window\.TERMUL_SESSION_ID\s*=\s*"([^"]+)"', html)
    
    if not token_match:
        print("AUTH_TOKEN not found in HTML!")
        return
        
    token = token_match.group(1)
    session_id = session_match.group(1) if session_match else None
    print(f"Extracted token: {token}")
    print(f"Extracted session ID: {session_id}")

    # 2. Connect to the WebSocket
    ws_url = "ws://127.0.0.1:9876/ws"
    print(f"Connecting to WebSocket at {ws_url}...")
    async with websockets.connect(ws_url) as ws:
        # Send auth
        auth_msg = {
            "type": "auth",
            "token": token,
            "projectId": None,
            "sessionId": session_id
        }
        await ws.send(json.dumps(auth_msg))
        print("Sent auth message, waiting for response...")
        
        auth_resp_raw = await ws.recv()
        print(f"Auth response: {auth_resp_raw}")
        auth_resp = json.loads(auth_resp_raw)
        
        if not auth_resp.get("success"):
            print("Authentication failed!")
            return
            
        # Send detect_shells request
        request_msg = {
            "type": "request",
            "id": "req-detect-shells",
            "method": "detect_shells",
            "params": None
        }
        await ws.send(json.dumps(request_msg))
        print("Sent detect_shells request, waiting for response...")
        
        resp_raw = await ws.recv()
        print(f"detect_shells response: {resp_raw}")

        # Send get_home_directory request
        request_msg = {
            "type": "request",
            "id": "req-home-dir",
            "method": "get_home_directory",
            "params": None
        }
        await ws.send(json.dumps(request_msg))
        print("Sent get_home_directory request, waiting for response...")
        
        resp_raw = await ws.recv()
        print(f"get_home_directory response: {resp_raw}")

if __name__ == "__main__":
    asyncio.run(test_ws())
