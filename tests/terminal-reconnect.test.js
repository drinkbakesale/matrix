'use strict';
// Drives the delivered terminal stream code (server/public/app.js connectWebSocket) in a VM.
// The server sends the pane's full scrollback as the first output on every connection, so an
// automatic reconnect must show that scrollback once, not append a second copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument } = require('./app-harness');

const SOURCE = fs.readFileSync(path.join(__dirname, '../server/public/app.js'), 'utf8');
const START = 'function connectWebSocket(';
const END = 'function openTerminal(';

function loadStream() {
  const start = SOURCE.indexOf(START);
  const end = SOURCE.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'connectWebSocket boundaries missing from app.js');
  const document = createDocument(['terminal']);
  const viewer = document.getElementById('terminal');
  viewer.addEventListener = () => {};
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
    ws: null,
    currentSession: null,
    userScrolledUp: false,
    deferredScreenUpdate: null,
    isNearBottom: () => true,
    terminalSelectionActive: () => false,
    pruneMessages: () => {},
    autoScroll: () => {},
    stripAnsi: s => s,
    filterStatusLines: s => s,
  });
  vm.runInContext(SOURCE.slice(start, end), context);
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
