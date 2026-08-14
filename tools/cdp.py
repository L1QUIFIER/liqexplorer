#!/usr/bin/env python3
"""Tiny CDP driver for testing LiqExplorer headless (needs the app launched with
--remote-debugging-port=9223 --remote-allow-origins='*').

  cdp.py eval 'EXPR'        evaluate JS in the page (awaits promises), print JSON result
  cdp.py shot OUT.png       capture the rendered frame (works where X `import` shows black)
  cdp.py console [SECS]     dump console messages + uncaught exceptions for SECS (default 2)
  cdp.py click X Y [right|dbl]
  cdp.py move X Y [left|right]   mouse move; the button name keeps it held (drag)
  cdp.py press X Y [right]       button down only
  cdp.py release X Y [right]     button up only
  cdp.py key NAME [ctrl] [shift] [alt]    NAME: a-z, 0-9, F1-F12, Enter, Escape, Delete,
                                          Backspace, Tab, Up, Down, Left, Right, Home, End
  cdp.py type 'TEXT'        type text into the focused element

Run with: python3 tools/cdp.py ...   (invoked via python3, no +x needed on CIFS)
"""
import json, sys, os, base64, time, urllib.request
from websocket import create_connection

PORT = os.environ.get('CDP_PORT', '9223')
_id = 0

def connect():
    tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json'))
    page = next(t for t in tabs if t['type'] == 'page')
    return create_connection(page['webSocketDebuggerUrl'], timeout=30)

def send(ws, method, params=None):
    global _id
    _id += 1
    ws.send(json.dumps({'id': _id, 'method': method, 'params': params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id:
            if 'error' in m:
                print('CDP error:', m['error'], file=sys.stderr)
                sys.exit(1)
            return m.get('result', {})

KEYMAP = {  # name -> (key, code, windowsVirtualKeyCode)
    'enter': ('Enter', 'Enter', 13), 'escape': ('Escape', 'Escape', 27),
    'delete': ('Delete', 'Delete', 46), 'backspace': ('Backspace', 'Backspace', 8),
    'tab': ('Tab', 'Tab', 9), 'up': ('ArrowUp', 'ArrowUp', 38),
    'down': ('ArrowDown', 'ArrowDown', 40), 'left': ('ArrowLeft', 'ArrowLeft', 37),
    'right': ('ArrowRight', 'ArrowRight', 39), 'home': ('Home', 'Home', 36),
    'end': ('End', 'End', 35), 'space': (' ', 'Space', 32),
}
for i in range(1, 13):
    KEYMAP[f'f{i}'] = (f'F{i}', f'F{i}', 111 + i)
for c in 'abcdefghijklmnopqrstuvwxyz':
    KEYMAP[c] = (c, 'Key' + c.upper(), ord(c.upper()))
for c in '0123456789':
    KEYMAP[c] = (c, 'Digit' + c, ord(c))

def main():
    cmd = sys.argv[1]
    ws = connect()
    if cmd == 'eval':
        r = send(ws, 'Runtime.evaluate', {
            'expression': sys.argv[2], 'awaitPromise': True, 'returnByValue': True})
        res = r.get('result', {})
        if 'exceptionDetails' in r:
            print('EXCEPTION:', json.dumps(r['exceptionDetails'].get('exception', {}).get('description',
                  r['exceptionDetails'].get('text'))))
            sys.exit(1)
        print(json.dumps(res.get('value'), indent=1, default=str))
    elif cmd == 'shot':
        r = send(ws, 'Page.captureScreenshot', {'format': 'png'})
        with open(sys.argv[2], 'wb') as f:
            f.write(base64.b64decode(r['data']))
        print('wrote', sys.argv[2])
    elif cmd == 'console':
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
        send(ws, 'Runtime.enable')
        send(ws, 'Log.enable')
        ws.settimeout(0.3)
        end = time.time() + secs
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            meth = m.get('method')
            if meth == 'Runtime.consoleAPICalled':
                p = m['params']
                vals = [a.get('value', a.get('description', '?')) for a in p['args']]
                print(f"[{p['type']}]", *vals)
            elif meth == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                print('[EXCEPTION]', d.get('exception', {}).get('description', d.get('text')))
            elif meth == 'Log.entryAdded':
                e = m['params']['entry']
                print(f"[{e['level']}]", e['text'][:300])
    elif cmd in ('click', 'move', 'press', 'release'):
        x, y = float(sys.argv[2]), float(sys.argv[3])
        opts = sys.argv[4:]
        if cmd == 'move':
            button = 'right' if 'right' in opts else ('left' if 'left' in opts else 'none')
            # buttons bitmask keeps a held button pressed across the move (drags)
            mask = 2 if button == 'right' else (1 if button == 'left' else 0)
            send(ws, 'Input.dispatchMouseEvent', {
                'type': 'mouseMoved', 'x': x, 'y': y, 'button': button, 'buttons': mask})
        elif cmd in ('press', 'release'):
            button = 'right' if 'right' in opts else 'left'
            send(ws, 'Input.dispatchMouseEvent', {
                'type': 'mousePressed' if cmd == 'press' else 'mouseReleased',
                'x': x, 'y': y, 'button': button, 'buttons': 2 if button == 'right' else 1,
                'clickCount': 1})
        else:
            button = 'right' if 'right' in opts else 'left'
            count = 2 if 'dbl' in opts else 1
            for n in range(count):
                for t in ('mousePressed', 'mouseReleased'):
                    send(ws, 'Input.dispatchMouseEvent', {
                        'type': t, 'x': x, 'y': y, 'button': button, 'clickCount': n + 1})
    elif cmd == 'key':
        name = sys.argv[2].lower()
        mods = sum({'alt': 1, 'ctrl': 2, 'shift': 8}[m] for m in sys.argv[3:])
        key, code, vk = KEYMAP[name]
        for t in ('rawKeyDown', 'keyUp'):
            send(ws, 'Input.dispatchKeyEvent', {
                'type': t, 'key': key, 'code': code, 'windowsVirtualKeyCode': vk,
                'nativeVirtualKeyCode': vk, 'modifiers': mods})
    elif cmd == 'type':
        for ch in sys.argv[2]:
            send(ws, 'Input.dispatchKeyEvent', {'type': 'char', 'text': ch})
    else:
        print(__doc__)
        sys.exit(1)
    ws.close()

if __name__ == '__main__':
    main()
