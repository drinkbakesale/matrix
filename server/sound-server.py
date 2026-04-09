#!/usr/bin/env python3
"""Persistent sound server — preloads squelch sounds, plays instantly on command."""
import json
import os
import socket
import sys
import threading
import numpy as np
import sounddevice as sd
import soundfile as sf

SOCKET_PATH = '/tmp/matrix-sound.sock'
SOUNDS_DIR = os.path.join(os.path.expanduser('~'), '.claude-remote', 'ptt-daemon', 'sounds')
VOLUME = 3.0

# Find USB mic speaker
USB_DEVICE = None
for d in sd.query_devices():
    if 'UAC' in d['name'] and d['max_output_channels'] > 0:
        USB_DEVICE = d['index']
        break

if USB_DEVICE is None:
    print('[sound] WARNING: USB speaker not found', file=sys.stderr)
    sys.exit(1)

print(f'[sound] USB speaker: device {USB_DEVICE}', file=sys.stderr)

# Preload sounds into memory
sounds = {}
for name in ['squelch_open', 'squelch_close']:
    path = os.path.join(SOUNDS_DIR, f'{name}.wav')
    if os.path.exists(path):
        data, sr = sf.read(path, dtype='float32')
        data = np.clip(data * VOLUME, -1, 1)
        sounds[name] = (data, sr)
        print(f'[sound] Loaded {name} ({len(data)} samples)', file=sys.stderr)

# Clean up old socket
if os.path.exists(SOCKET_PATH):
    os.unlink(SOCKET_PATH)

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(SOCKET_PATH)
sock.listen(5)
os.chmod(SOCKET_PATH, 0o666)

print(f'[sound] Ready on {SOCKET_PATH}', file=sys.stderr, flush=True)

while True:
    conn, _ = sock.accept()
    try:
        cmd = conn.recv(256).decode().strip()
        if cmd in sounds:
            data, sr = sounds[cmd]
            # Fire and forget — don't block the socket
            threading.Thread(target=lambda d=data, s=sr: sd.play(d, samplerate=s, device=USB_DEVICE, blocking=True), daemon=True).start()
            conn.sendall(b'ok')
        else:
            conn.sendall(b'unknown')
    except:
        pass
    finally:
        conn.close()
