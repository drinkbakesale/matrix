#!/usr/bin/env python3
"""Persistent Whisper transcription server.

Listens on a Unix socket (/tmp/matrix-whisper.sock) for a WAV file path, returns
JSON {"text": "..."} with the transcription.

Model is loaded once at startup and kept resident so each transcription is fast
(no disk load per request). Handles arbitrary-length audio — Whisper chunks
internally. Default model is `base` which is ~10x more accurate than `tiny`
with only a small latency cost on M-series Macs.
"""
import json
import os
import socket
import sys

SOCKET_PATH = "/tmp/matrix-whisper.sock"
# Override via env. Accuracy/speed tradeoff: tiny < base < small < medium < large.
# `base` is a good default: ~140MB, fast, noticeably better than tiny. Upgrade
# to `small` (~460MB) or `medium` (~1.4GB) for harder audio. Both already cached
# on this machine (see ~/.cache/whisper).
MODEL_NAME = os.environ.get('WHISPER_MODEL', 'base')
LANGUAGE = os.environ.get('WHISPER_LANGUAGE', 'en')

print(f"[whisper-server] Loading model '{MODEL_NAME}'...", file=sys.stderr, flush=True)
import whisper
model = whisper.load_model(MODEL_NAME)
print(f"[whisper-server] Model '{MODEL_NAME}' loaded, ready.", file=sys.stderr, flush=True)

# Clean up old socket
if os.path.exists(SOCKET_PATH):
    os.unlink(SOCKET_PATH)

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(SOCKET_PATH)
sock.listen(1)
os.chmod(SOCKET_PATH, 0o600)

while True:
    conn, _ = sock.accept()
    try:
        data = conn.recv(4096).decode().strip()
        if not data:
            conn.sendall(b'{"text":""}')
            continue
        # language hint prevents misidentification on short clips; fp16=False
        # uses float32 which is stable across Apple Silicon Metal backends.
        result = model.transcribe(data, fp16=False, language=LANGUAGE)
        text = result["text"].strip()
        conn.sendall(json.dumps({"text": text}).encode())
    except Exception as e:
        print(f"[whisper-server] Error: {e}", file=sys.stderr, flush=True)
        try:
            conn.sendall(b'{"text":""}')
        except:
            pass
    finally:
        conn.close()
