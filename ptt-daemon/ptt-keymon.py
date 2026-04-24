#!/usr/bin/env python3
"""
PTT Key Monitor — two independent push-to-talk modes on the same CGEventTap:

1. Matrix browser PTT (keycode 120 / F2, from the QX18A mic button):
   plays squelch sounds, POSTs start/stop to Matrix SSE, passes the F2 event
   through so the browser can record via MediaRecorder.

2. Global dictation (configurable keycode, default F6=97):
   records audio in-process, transcribes via Apple STT → Whisper fallback,
   injects the transcribed text as keystrokes into the frontmost app via
   CGEventKeyboardSetUnicodeString. Works in iMessage, Notes, Chrome, etc.
   The dictation hotkey is CONSUMED (not passed through) so the focused app
   doesn't also receive the keypress.
"""
import sys
import os
import re
import time
import threading
import subprocess
import tempfile
import json
import socket
import requests
import numpy as np
import sounddevice as sd
import soundfile as sf
import Quartz
from Foundation import NSRunLoop, NSDate

MATRIX_URL = 'http://localhost:7778/api/ptt-event'
SOUNDS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sounds')

# Find USB mic speaker device (UACDemoV1.0 output)
USB_DEVICE = None
for d in sd.query_devices():
    if 'UAC' in d['name'] and d['max_output_channels'] > 0:
        USB_DEVICE = d['index']
        break

if USB_DEVICE is not None:
    print(f'[PTT] USB speaker: device {USB_DEVICE}', flush=True)
else:
    print('[PTT] WARNING: USB speaker not found, squelch sounds disabled', flush=True)

# Squelch volume multiplier — 1.0 = file native, 0.1 = ~10%.
# The QX18A has strong fixed hardware gain, so small multipliers still produce
# a clearly audible chirp. Bump SQUELCH_VOLUME env var higher if too quiet.
SQUELCH_VOLUME = float(os.environ.get('SQUELCH_VOLUME', '0.1'))

# Pre-load sound files (and apply volume scaling once, in-place)
squelch_open = None
squelch_close = None
try:
    squelch_open, sr_open = sf.read(os.path.join(SOUNDS_DIR, 'squelch_open.wav'), dtype='float32')
    squelch_close, sr_close = sf.read(os.path.join(SOUNDS_DIR, 'squelch_close.wav'), dtype='float32')
    squelch_open = np.clip(squelch_open * SQUELCH_VOLUME, -1, 1)
    squelch_close = np.clip(squelch_close * SQUELCH_VOLUME, -1, 1)
    print(f'[PTT] Sounds loaded at {SQUELCH_VOLUME:.2f}x volume '
          f'(override via SQUELCH_VOLUME env var). '
          f'open={len(squelch_open)} samples, close={len(squelch_close)} samples', flush=True)
except Exception as e:
    print(f'[PTT] WARNING: Could not load sounds: {e}', flush=True)


def play_sound(sound_data, sample_rate=48000):
    """Play a sound through the USB mic speaker in a background thread."""
    if USB_DEVICE is None or sound_data is None:
        return
    def _play():
        try:
            sd.play(sound_data, samplerate=sample_rate, device=USB_DEVICE, blocking=True)
        except Exception as e:
            print(f'[PTT] Sound playback error: {e}', flush=True)
    threading.Thread(target=_play, daemon=True).start()


def post_event(event):
    """POST PTT event to Matrix server (non-blocking)."""
    def _post():
        try:
            requests.post(MATRIX_URL, json={'event': event}, timeout=1)
        except Exception as e:
            print(f'[PTT] POST failed: {e}', flush=True)
    threading.Thread(target=_post, daemon=True).start()


# ──────────────────────────────────────────────────────────────────────────────
# Global Dictation — hotkey-triggered STT that types into the frontmost app.
# Independent of Matrix: records audio in-process, transcribes via Apple STT
# → Whisper fallback, injects keystrokes via CGEventKeyboardSetUnicodeString.
# ──────────────────────────────────────────────────────────────────────────────

STT_TOOL = os.path.expanduser('~/.claude-remote/stt-tool/.build/release/stt-tool')
WHISPER_SOCKET = '/tmp/matrix-whisper.sock'
# Default to F6 (keycode 97). Override with env var DICTATE_KEYCODE.
# Safe choices: F6=97, F7=98, F8=100, F13=105. Avoid F2 (in use), F5 (system dictation).
DICTATE_KEYCODE = int(os.environ.get('DICTATE_KEYCODE', '97'))
DICTATE_MIN_MS = 200          # taps shorter than this are ignored
DICTATE_MAX_S = 30            # hard cap so a stuck key doesn't record forever
SAMPLE_RATE = 16000
CHANNELS = 1

# Find USB mic INPUT device (alongside the speaker output already detected).
# Falls back to system default input if USB mic isn't plugged in.
USB_INPUT_DEVICE = None
for d in sd.query_devices():
    if ('UAC' in d['name'] or 'QX' in d['name']) and d['max_input_channels'] > 0:
        USB_INPUT_DEVICE = d['index']
        break

if USB_INPUT_DEVICE is not None:
    print(f'[DICTATE] USB mic input: device {USB_INPUT_DEVICE}', flush=True)
else:
    print('[DICTATE] USB mic input not found; will use system default when hotkey pressed', flush=True)


def _get_input_device():
    if USB_INPUT_DEVICE is not None:
        return USB_INPUT_DEVICE
    try:
        default_in = sd.default.device[0] if sd.default.device else -1
        if default_in is not None and default_in >= 0:
            return default_in
    except Exception:
        pass
    # Last resort: any device with input channels
    for d in sd.query_devices():
        if d['max_input_channels'] > 0:
            return d['index']
    return None


# Dictation state machine — guarded by dictate_lock
dictate_lock = threading.Lock()
dictate_state = 'idle'        # 'idle' | 'recording' | 'processing'
dictate_stream = None
dictate_buffer = []
dictate_start_time = 0.0
# The app that was frontmost when dictation STARTED. We restore focus to it
# before typing, so a focus shift during the hold doesn't send text to the wrong
# window (e.g. the terminal tailing the log).
target_app = None


def _capture_target_app():
    """Remember which app was frontmost when the mic button was pressed."""
    global target_app
    try:
        from AppKit import NSWorkspace
        target_app = NSWorkspace.sharedWorkspace().frontmostApplication()
    except Exception as e:
        target_app = None
        print(f'[DICTATE] Could not capture target app: {e}', flush=True)


_SKIP_ACTIVATION_BUNDLES = {
    'com.apple.finder',           # ambient default when nothing else is frontmost
    'com.apple.loginwindow',
    'com.apple.dock',
    'com.apple.systemuiserver',
}


def _restore_target_app():
    """Re-activate the originally-captured app before injecting keystrokes.

    Skips activation if the captured target is a system surface (Finder, Dock,
    loginwindow) because those are usually false positives that appear briefly
    when focus was in transition. In that case we let the keystrokes land in
    whatever app is currently frontmost — better than forcing focus to Finder.
    """
    if target_app is None:
        return False
    try:
        bundle = target_app.bundleIdentifier() or ''
    except Exception:
        bundle = ''
    if bundle in _SKIP_ACTIVATION_BUNDLES:
        print(f'[DICTATE] Skipping activation of {bundle} (focus was in transition; '
              f'typing into whatever is frontmost now)', flush=True)
        return False
    try:
        target_app.activateWithOptions_(2)  # NSApplicationActivateIgnoringOtherApps
        time.sleep(0.12)  # let WindowServer settle the focus change
        return True
    except Exception as e:
        print(f'[DICTATE] Could not re-activate target app: {e}', flush=True)
        return False


def _copy_to_clipboard(text):
    """Always-safe fallback — user can Cmd+V anywhere if typing fails."""
    try:
        p = subprocess.Popen(['pbcopy'], stdin=subprocess.PIPE)
        p.communicate(text.encode('utf-8'), timeout=2)
    except Exception as e:
        print(f'[DICTATE] Clipboard copy failed: {e}', flush=True)


def _dictate_audio_callback(indata, frames, time_info, status):
    if dictate_state == 'recording':
        dictate_buffer.append(indata.copy())


def start_dictate_recording():
    """Called from the event-tap callback — MUST return in microseconds or the
    OS will disable the tap (causing F2 to leak through as a system brightness
    key, which steals focus). All blocking work (device query, InputStream
    construction, CoreAudio init) is done in a background thread.
    """
    # These two things MUST happen synchronously on the event tap thread:
    # (1) capture the intended target before focus starts drifting
    # (2) gate the state transition so re-entry is rejected
    _capture_target_app()
    with dictate_lock:
        if dictate_state != 'idle':
            return
        # Tentative: mark as recording so a rapid release still finds the right
        # state. If audio setup fails below we reset it.
        globals()['dictate_state'] = 'recording'
        globals()['dictate_buffer'] = []
        globals()['dictate_start_time'] = time.time()
    threading.Thread(target=_start_audio_async, daemon=True).start()


def _start_audio_async():
    """Runs the actual PortAudio stream setup off the event-tap thread."""
    global dictate_stream
    device = _get_input_device()
    if device is None:
        print('[DICTATE] No input device available — cannot record', flush=True)
        with dictate_lock:
            globals()['dictate_state'] = 'idle'
        return
    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            device=device,
            callback=_dictate_audio_callback,
            dtype='float32',
        )
        stream.start()
    except Exception as e:
        print(f'[DICTATE] Recording failed to start: {e}', flush=True)
        with dictate_lock:
            globals()['dictate_state'] = 'idle'
        return
    with dictate_lock:
        if dictate_state != 'recording':
            # User already released — discard the stream we just opened
            try: stream.stop()
            except Exception: pass
            try: stream.close()
            except Exception: pass
            return
        dictate_stream = stream
    play_sound(squelch_open)
    tgt = target_app.localizedName() if target_app else '<unknown>'
    print(f'[DICTATE] recording start (device={device}, target={tgt})', flush=True)


def stop_dictate_recording():
    """Called from the event-tap callback — must return fast. Closes the stream
    and runs transcription/typing off-thread."""
    with dictate_lock:
        if dictate_state != 'recording':
            return
        globals()['dictate_state'] = 'processing'
        duration_ms = (time.time() - dictate_start_time) * 1000
    threading.Thread(target=_stop_audio_and_process, args=(duration_ms,), daemon=True).start()


def _stop_audio_and_process(duration_ms):
    global dictate_stream
    with dictate_lock:
        stream = dictate_stream
        dictate_stream = None
    if stream is not None:
        try: stream.stop()
        except Exception: pass
        try: stream.close()
        except Exception: pass
    play_sound(squelch_close)
    print(f'[DICTATE] recording stop ({duration_ms:.0f}ms)', flush=True)
    _dictate_process(duration_ms)


def _dictate_process(duration_ms):
    global dictate_state
    try:
        if duration_ms < DICTATE_MIN_MS:
            print(f'[DICTATE] Too short ({duration_ms:.0f}ms) — ignoring', flush=True)
            return
        if not dictate_buffer:
            print('[DICTATE] No audio captured', flush=True)
            return
        audio = np.concatenate(dictate_buffer, axis=0)
        wav_path = os.path.join(tempfile.gettempdir(), f'ptt-dictate-{os.getpid()}.wav')
        try:
            sf.write(wav_path, audio, SAMPLE_RATE)
            text = _transcribe(wav_path)
        finally:
            try: os.unlink(wav_path)
            except Exception: pass
        if not text:
            print('[DICTATE] No transcription result', flush=True)
            return
        raw = text
        text = cleanup_transcription(text)
        print(f'[DICTATE] raw={raw!r} → cleaned={text!r}', flush=True)
        # Always copy to clipboard so the user can Cmd+V it anywhere if the
        # automatic typing into the target app doesn't land correctly.
        _copy_to_clipboard(text)
        # Restore focus to the app that was frontmost at press time, so text
        # lands where the user expected even if focus drifted during the hold.
        _restore_target_app()
        type_text(text)
    except Exception as e:
        print(f'[DICTATE] Processing error: {e}', flush=True)
    finally:
        with dictate_lock:
            dictate_state = 'idle'


# ── Transcription cleanup ────────────────────────────────────────────────────

_INTERROGATIVES = {
    'what', 'where', 'why', 'how', 'when', 'who', 'which', 'whose', 'whom',
    "what's", "where's", "why's", "how's", "when's", "who's",
    'whats', 'wheres', 'whys', 'hows', 'whens', 'whos',
}
_AUX_VERBS = {
    'is', 'are', 'was', 'were', 'am',
    'do', 'does', 'did',
    'can', 'could', 'will', 'would', 'should',
    'may', 'might', 'has', 'have', 'had', 'shall', 'must',
    "doesn't", "don't", "didn't", "isn't", "aren't", "wasn't", "weren't",
    "can't", "couldn't", "wouldn't", "shouldn't", "won't",
    "hasn't", "haven't", "hadn't", 'dont', 'doesnt', 'didnt', 'isnt',
}
_PRONOUN_SUBJECTS = {
    'you', 'we', 'i', 'they', 'he', 'she', 'it', 'there',
    'this', 'that', 'these', 'those', 'someone', 'anyone', 'anybody',
}
_FILLERS = {'um', 'uh', 'uhh', 'umm', 'ummm', 'er', 'erm', 'hmm'}

# Preamble words that come before the "real" first word — "OK so does this work"
# should be treated as "does this work" for question detection.
_PREAMBLE = {'ok', 'okay', 'so', 'well', 'now', 'hey', 'alright', 'right'}


def cleanup_transcription(text):
    """Post-process raw STT output: punctuation, capitalization, filler removal."""
    if not text:
        return text

    # Normalize whitespace
    t = re.sub(r'\s+', ' ', text.strip())
    if not t:
        return t

    # Strip leading/trailing filler words (um, uh, etc). Keep content words only.
    parts = t.split()
    while parts and parts[0].lower().strip(',.!?') in _FILLERS:
        parts.pop(0)
    while parts and parts[-1].lower().strip(',.!?') in _FILLERS:
        parts.pop()
    if not parts:
        return ''
    t = ' '.join(parts)

    # Collapse adjacent duplicate words ("the the", "I I")
    t = re.sub(r'\b(\w+)(\s+\1\b)+', r'\1', t, flags=re.IGNORECASE)

    # Capitalize the first letter
    t = t[0].upper() + t[1:]

    # Terminal punctuation decision.
    # Skip leading preamble words ("OK so does this work" → analyze from "does").
    check_idx = 0
    while check_idx < len(parts) and parts[check_idx].lower().strip(',.!?') in _PREAMBLE:
        check_idx += 1
    pivot_word = parts[check_idx].lower().strip(',.!?') if check_idx < len(parts) else ''
    after_pivot = parts[check_idx + 1].lower().strip(',.!?') if check_idx + 1 < len(parts) else ''
    is_question = False
    if pivot_word in _INTERROGATIVES:
        is_question = True
    elif pivot_word in _AUX_VERBS and after_pivot in _PRONOUN_SUBJECTS:
        # "Is this working", "Can we go", "Does that make sense"
        is_question = True

    ends_with_punct = re.search(r'[.!?]$', t) is not None
    if ends_with_punct:
        # Apple STT tends to use `.` even for questions. Swap to `?` when the
        # sentence shape clearly signals a question.
        if is_question and t.endswith('.'):
            t = t[:-1] + '?'
    else:
        t += '?' if is_question else '.'

    return t


def _transcribe(wav_path):
    """Whisper is primary (handles arbitrary audio length reliably); Apple STT
    is a fallback when the Whisper server isn't running.

    Historical note: Apple STT used to be primary for speed, but
    SFSpeechRecognizer has a hard ~10s window in practice and silently returned
    only the tail of long recordings. Whisper `base` handles any length and
    produces more accurate transcripts, at a cost of ~1-3s extra latency.
    """
    # Whisper first — reliable at any audio length
    if os.path.exists(WHISPER_SOCKET):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(60)  # base model on 30s+ audio can need several seconds
            s.connect(WHISPER_SOCKET)
            s.sendall(wav_path.encode())
            resp = b''
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                resp += chunk
            s.close()
            if resp:
                text = (json.loads(resp.decode()).get('text') or '').strip()
                if text:
                    return text
        except Exception as e:
            print(f'[DICTATE] Whisper failed: {e}', flush=True)
    # Apple STT fallback — only used when Whisper server is unreachable
    if os.path.exists(STT_TOOL):
        try:
            out = subprocess.run(
                [STT_TOOL, wav_path],
                capture_output=True, text=True, timeout=65,
            )
            if out.stdout.strip():
                data = json.loads(out.stdout.strip())
                text = (data.get('text') or '').strip()
                if text:
                    return text
        except Exception as e:
            print(f'[DICTATE] Apple STT failed: {e}', flush=True)
    return ''


def _frontmost_app_name():
    """Return the bundle identifier of the currently-frontmost macOS app."""
    try:
        from AppKit import NSWorkspace
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is not None:
            return f"{app.localizedName()} ({app.bundleIdentifier()})"
    except Exception as e:
        return f'<unknown: {e}>'
    return '<none>'


# macOS virtual keycode for 'V'
_KEYCODE_V = 9


def _paste_via_cmd_v():
    """Send Cmd+V to the frontmost app. Works in terminals AND native apps,
    unlike Unicode character injection which iTerm2 and some other apps filter
    out. The transcription is already on the clipboard at this point.
    """
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    # Cmd down
    cmd_down = Quartz.CGEventCreateKeyboardEvent(src, 0x37, True)  # left cmd
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, cmd_down)
    # V down with Cmd flag
    v_down = Quartz.CGEventCreateKeyboardEvent(src, _KEYCODE_V, True)
    Quartz.CGEventSetFlags(v_down, Quartz.kCGEventFlagMaskCommand)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, v_down)
    time.sleep(0.02)
    # V up
    v_up = Quartz.CGEventCreateKeyboardEvent(src, _KEYCODE_V, False)
    Quartz.CGEventSetFlags(v_up, Quartz.kCGEventFlagMaskCommand)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, v_up)
    # Cmd up
    cmd_up = Quartz.CGEventCreateKeyboardEvent(src, 0x37, False)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, cmd_up)


def _type_char_by_char(text):
    """Inject Unicode text via CGEventKeyboardSetUnicodeString (char-by-char).
    Works in most apps but iTerm2/Terminal filter these as synthetic events.
    """
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    CHUNK = 20
    for i in range(0, len(text), CHUNK):
        part = text[i:i + CHUNK]
        down = Quartz.CGEventCreateKeyboardEvent(src, 0, True)
        Quartz.CGEventKeyboardSetUnicodeString(down, len(part), part)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
        up = Quartz.CGEventCreateKeyboardEvent(src, 0, False)
        Quartz.CGEventKeyboardSetUnicodeString(up, len(part), part)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
        time.sleep(0.01)


def type_text(text):
    """Deliver transcribed text to the frontmost app.

    Primary mechanism: Cmd+V paste from clipboard. Works reliably in terminals
    (iTerm2, Terminal), browsers, editors, and native macOS apps — anywhere
    Cmd+V is the paste shortcut.

    Override via env DICTATE_TYPE_MODE:
      'paste' (default) — send Cmd+V
      'chars'           — type character-by-character via Unicode event injection
                          (doesn't work in iTerm2, but preserves clipboard in
                          apps that remap Cmd+V to something else)
    """
    if not text:
        return
    print(f'[DICTATE] typing into: {_frontmost_app_name()}', flush=True)
    mode = os.environ.get('DICTATE_TYPE_MODE', 'paste').lower()
    if mode == 'chars':
        _type_char_by_char(text)
    else:
        _paste_via_cmd_v()


# Track state per keycode to detect press/release
pressed_keys = set()

# Discovery mode
discover_mode = '--discover' in sys.argv


def callback(proxy, event_type, event, refcon):
    keycode = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode)

    if discover_mode:
        etype = 'DOWN' if event_type == Quartz.kCGEventKeyDown else 'UP' if event_type == Quartz.kCGEventKeyUp else f'OTHER({event_type})'
        flags = Quartz.CGEventGetFlags(event)
        print(f'[KEY] {etype} keycode={keycode} flags=0x{flags:x}', flush=True)
        return event

    # F2 (keycode 120) = QX18A mic button. This is now THE dictation hotkey:
    # record → transcribe → type into the frontmost app (iMessage, Notes, Chrome,
    # Matrix's own chat input, anything). We consume the event (return None) so
    # the browser doesn't also start a parallel MediaRecorder and duplicate the
    # transcribed text.
    #
    # We still POST /api/ptt-event so the Matrix dashboard can render its
    # recording-state indicator via SSE.
    #
    # DICTATE_KEYCODE (default F6) is a keyboard-only fallback for when the
    # USB mic button is unavailable.
    if keycode == 120 or keycode == DICTATE_KEYCODE:
        if event_type == Quartz.kCGEventKeyDown:
            if keycode not in pressed_keys:
                pressed_keys.add(keycode)
                if keycode == 120:
                    post_event('start')  # Matrix UI indicator only
                start_dictate_recording()
                print(f'[PTT] keycode={keycode} DOWN — recording', flush=True)
        elif event_type == Quartz.kCGEventKeyUp:
            pressed_keys.discard(keycode)
            if keycode == 120:
                post_event('stop')
            stop_dictate_recording()
            print(f'[PTT] keycode={keycode} UP — transcribing + typing', flush=True)
        return None  # consume — daemon owns both hotkeys end-to-end

    return event


def check_tap_active(tap):
    """Re-enable event tap if macOS disabled it."""
    if not Quartz.CGEventTapIsEnabled(tap):
        print('[PTT] Event tap was disabled, re-enabling...', flush=True)
        Quartz.CGEventTapEnable(tap, True)


def main():
    if discover_mode:
        print('[PTT] Discovery mode — press buttons on the QX18A mic. Ctrl+C to stop.')
    else:
        print('[PTT] Monitoring for QX18A PTT button (keycode 120 / F2). Ctrl+C to stop.')
        print(f'[DICTATE] Global dictation hotkey: keycode {DICTATE_KEYCODE} '
              f'(override via DICTATE_KEYCODE env var)', flush=True)

    mask = (1 << Quartz.kCGEventKeyDown) | (1 << Quartz.kCGEventKeyUp)
    tap = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionDefault,
        mask,
        callback,
        None
    )

    if tap is None:
        print('[PTT] ERROR: Could not create event tap. Grant Accessibility permission to Terminal/iTerm.')
        print('[PTT] System Preferences → Privacy & Security → Accessibility → add your terminal app')
        sys.exit(1)

    source = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    loop = Quartz.CFRunLoopGetCurrent()
    Quartz.CFRunLoopAddSource(loop, source, Quartz.kCFRunLoopDefaultMode)
    Quartz.CGEventTapEnable(tap, True)

    print('[PTT] Event tap active. Listening...', flush=True)

    try:
        while True:
            # Short run-loop slice + aggressive tap-alive check. If the tap
            # ever gets disabled by the OS (which is what lets F2 leak through
            # as a system brightness key and causes focus to escape to Finder),
            # we re-enable it within ~0.5s.
            NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.5))
            check_tap_active(tap)
    except KeyboardInterrupt:
        print('\n[PTT] Stopped.')


if __name__ == '__main__':
    main()
