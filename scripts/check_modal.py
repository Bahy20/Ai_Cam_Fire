"""Non-inference deployment checks; output contains no credentials."""
import asyncio
import json
from pathlib import Path
import requests
from websockets.asyncio.client import connect

async def main():
    root=Path(__file__).resolve().parents[1]
    config=json.loads((root/'analysis/.modal-client.json').read_text())
    url=config['url'];headers={'Authorization':'Bearer '+config['token']}
    health=requests.get(url+'/health',timeout=180);health.raise_for_status()
    denied=requests.get(url+'/v1/videos/auth-check',timeout=30)
    allowed=requests.get(url+'/v1/videos/auth-check',headers=headers,timeout=30)
    assert denied.status_code==401,denied.status_code
    assert allowed.status_code==404,allowed.status_code
    ws_status=None
    try:
        async with connect(url.replace('https:','wss:')+'/v1/live',open_timeout=30):
            raise AssertionError('WebSocket accepted without authorization')
    except Exception as error:
        ws_status=getattr(getattr(error,'response',None),'status_code',None)
        # Modal's web_server proxy turns an upstream WS handshake 401 into 500.
        # Confirmed in deployment logs; HTTP auth and authorized WSS are checked separately.
        if ws_status not in (401,500):raise
    print(json.dumps({'url':url,'health':health.json(),'http_without_token':denied.status_code,
                      'authenticated_lookup':allowed.status_code,'websocket_without_token':ws_status},indent=2))

if __name__=='__main__':asyncio.run(main())
