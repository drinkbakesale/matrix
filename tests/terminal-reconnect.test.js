'use strict';
// Drives the delivered terminal stream code (server/public/app.js connectWebSocket) on top
// of the delivered transcript controller (server/public/matrix-transcript.js) in a VM.
// The server sends the pane's full scrollback as the first output on every connection, so an
// automatic reconnect must show that scrollback once, not append a second copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createDocument } = require('./app-harness');
const { readFile, slice } = require('./client-sources');

const TRANSCRIPT = readFile('matrix-transcript.js');
const STREAM = slice('app.js', 'function connectWebSocket(', 'function openTerminal(');

function loadStream() {
  const document = createDocument(['terminal']);
  const viewer = document.getElementById('terminal');
  const sockets = [];
  const timers = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; sockets.push(this); }
    send() {}
    close() {}
  }
  const context = vm.createContext({
    document,
    location: { protocol: 'http:', host: 'matrix.test' },
    WebSocket: FakeWebSocket,
    console: { log() {} },
    JSON,
    setTimeout: fn => timers.push(fn),
    clearTimeout: () => {},
    ws: null,
    currentSession: null,
    currentWindowName: '',
    stripAnsi: s => s,
    filterStatusLines: s => s,
  });
  context.window = context;
  // The delivered controller owns every #terminal mutation, so the stream code is exercised
  // against it rather than against stubs.
  vm.runInContext(TRANSCRIPT, context);
  context.transcript = context.MatrixTranscript.createTranscript({ viewer, document });
  vm.runInContext(STREAM, context);
  const output = (socket, text) => socket.onmessage({ data: JSON.stringify({ type: 'output', data: text }) });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  return { context, viewer, sockets, output, runTimers };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('an automatic reconnect shows the scrollback dump once, not twice', () => {
  const { context, viewer, sockets, output, runTimers } = loadStream();
  context.currentSession = '41';
  context.connectWebSocket('41');
  output(sockets[0], 'first line\r\nsecond line\r\n');
  assert.equal(count(viewer.textContent, 'first line'), 1);

  sockets[0].onclose();
  runTimers();
  assert.equal(sockets.length, 2, 'socket close should schedule a reconnect');
  output(sockets[1], 'first line\r\nsecond line\r\n');

  assert.equal(count(viewer.textContent, 'first line'), 1);
  assert.equal(count(viewer.textContent, 'second line'), 1);
});

test('output after the reconnect dump appends to it', () => {
  const { context, viewer, sockets, output, runTimers } = loadStream();
  context.currentSession = '41';
  context.connectWebSocket('41');
  output(sockets[0], 'first line\r\n');
  sockets[0].onclose();
  runTimers();
  output(sockets[1], 'first line\r\n');
  output(sockets[1], 'new line\r\n');

  assert.equal(count(viewer.textContent, 'first line'), 1);
  assert.equal(count(viewer.textContent, 'new line'), 1);
});

test('a screen refresh replaces the live screen block instead of stacking copies', () => {
  const { context, viewer, sockets, output } = loadStream();
  context.currentSession = '41';
  context.connectWebSocket('41');
  output(sockets[0], 'history\r\n');
  const screen = (text) => sockets[0].onmessage({ data: JSON.stringify({ type: 'screen', data: text }) });
  screen('live one');
  screen('live two');
  assert.equal(count(viewer.textContent, 'live one'), 0);
  assert.equal(count(viewer.textContent, 'live two'), 1);
  assert.equal(viewer.querySelectorAll('.msg-screen').length, 1);
});

// A reconnect does not clear the transcript, so the new connection would inherit the dead
// one's token unless connectWebSocket ADVANCES the epoch. Nulling the old socket's handlers
// cannot retire a callback that was already dispatched: it holds the handler itself.
test('a superseded connection cannot write to the transcript after a reconnect', () => {
  const { context, viewer, sockets, output, runTimers } = loadStream();
  context.currentSession = '41';
  context.connectWebSocket('41');
  const staleMessage = sockets[0].onmessage;
  const staleClose = sockets[0].onclose;
  output(sockets[0], 'old connection line\r\n');

  staleClose();
  runTimers();
  output(sockets[1], 'new connection line\r\n');
  const socketsAfterReconnect = sockets.length;

  staleMessage({ data: JSON.stringify({ type: 'output', data: 'old connection line\r\n' }) });
  staleMessage({ data: JSON.stringify({ type: 'screen', data: 'old screen text' }) });
  staleClose();
  runTimers();

  assert.equal(count(viewer.textContent, 'old connection line'), 0, 'stale output must not land');
  assert.equal(count(viewer.textContent, 'old screen text'), 0, 'stale screen must not land');
  assert.equal(count(viewer.textContent, 'new connection line'), 1, 'the live connection keeps its text');
  assert.equal(sockets.length, socketsAfterReconnect, 'an obsolete close must not open another socket');
});
