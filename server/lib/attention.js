'use strict';
// Shared "this session is waiting for you" state.
//
// Attention is driven by notification hooks, not by parsing tmux. The maps may be keyed by
// the tmux session name OR by a display-name variant (older hooks post the display name),
// so every clear walks both. Extracted from server.js with no behaviour change.

const pendingAttention = {};      // key → true when a notification fired
const lastSeenQuestions = {};     // key → last question text, to avoid re-triggering
const dismissedUntilChange = {};  // key → dismissed message text; suppress until it changes

function lastSessions() {
  return global._lastSessions || [];
}

function setLastSessions(sessions) {
  global._lastSessions = sessions;
  global._lastSessionsAt = Date.now();
}

function lastSessionsAt() {
  return global._lastSessionsAt || 0;
}

function variantKeys(session) {
  const keys = [session];
  const match = lastSessions().find(s => s.name === session);
  if (match && match.displayName) keys.push(match.displayName, match.displayName.toLowerCase());
  return keys;
}

// The user just acted on this session: it no longer needs their attention.
function clearForSession(session) {
  for (const key of variantKeys(session)) {
    delete pendingAttention[key];
    delete lastSeenQuestions[key];
    delete dismissedUntilChange[key];
  }
}

// The user snoozed it: remember the exact question so only a genuinely new one re-alerts.
function dismissSession(session) {
  const lastMsg = lastSeenQuestions[session] || '*';
  for (const key of variantKeys(session)) {
    dismissedUntilChange[key] = lastMsg;
    delete pendingAttention[key];
    delete lastSeenQuestions[key];
  }
  return lastMsg;
}

module.exports = {
  pendingAttention, lastSeenQuestions, dismissedUntilChange,
  lastSessions, setLastSessions, lastSessionsAt, variantKeys,
  clearForSession, dismissSession,
};
