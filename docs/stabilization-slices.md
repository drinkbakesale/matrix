# Stabilization Slices — Matrix Console

## slice_001
name: dedup-drops-unrelated-sessions
status: verified
priority: critical
workflow: session-list-display
trigger: GET /api/sessions polls every few seconds
expected_result: All 17 tmux sessions appear in the UI with correct, distinct project names
observed_result: Only 8 of 17 sessions shown (BEFORE FIX). After fix: 16/17 shown (1 correctly deduped).
root_cause: Three compounding issues — (1) scrollback path extraction (old Method 4) was noisy and picked up incidental path mentions, causing unrelated sessions to share displayNames; (2) dedup aggressively merged ALL sessions with the same displayName regardless of confidence; (3) dedup stored first-seen confirmed sessions under `__unique_` key, preventing subsequent matches
components:
  - server/server.js (GET /api/sessions, displayName detection, dedup logic)
contracts:
  - GET /api/sessions returns { sessions: [...] }
notes:
  - root_cause: Noisy scrollback heuristic + blind dedup on unconfirmed names
  - files_changed: server/server.js
  - fix: (1) Removed scrollback path scan (old Method 4) entirely. (2) Added `projectConfirmed` flag — Methods 1-3 and named sessions set it true. (3) Dedup only merges sessions where BOTH have projectConfirmed=true. (4) Confirmed sessions stored under displayName key (not __unique_) so subsequent matches work.
  - tests_added: manual verification — 17 tmux sessions → 16 in API (1 correct dedup)
  - remaining_risk: Sessions without @matrix_project or non-home-dir path show pane title as displayName (conversation description, not project name) — cosmetic but not incorrect
  - iteration_count: 1

## slice_002
name: stale-attention-flags
status: verified
priority: high
workflow: notification-attention-cycle
trigger: Claude asks a question -> notification fires -> user dismisses or responds
expected_result: Attention clears when user responds or dismisses; does not re-fire for same question
observed_result: Multiple sessions showing needsAttention=true that likely shouldn't be (BEFORE FIX). After fix: periodic cleanup resolves displayName-keyed entries via _lastSessions and prunes orphans.
root_cause: pendingAttention was keyed by arbitrary session identifier (tmux name OR displayName, whichever cr-notify used). Periodic cleanup only called `tmux capture-pane -t '${key}:0'` which silently failed for displayName-keyed entries (e.g., key="vanguard" when tmux session is "0"). Stale entries accumulated forever. Deleted-tmux-session entries were never cleaned up either.
components:
  - server/server.js (pendingAttention, dismissedUntilChange, periodic cleanup)
  - server/public/app.js (dismiss/undismiss logic)
  - server/public/desktop.js (dismiss/undismiss logic)
contracts:
  - POST /api/dismiss clears attention
  - SSE notification events
notes:
  - root_cause: displayName-keyed pendingAttention entries were unreachable by periodic cleanup that used tmux name
  - files_changed: server/server.js (periodic cleanup at line 1058)
  - fix: (1) Resolve each pending-attention key via global._lastSessions to find matching tmux session. (2) For each live session, check all key variants (name, displayName, displayName.toLowerCase()) and clear ALL of them when spinner/progress detected. (3) Prune orphan entries whose keys don't match any live session.
  - tests_added: manual verification — restart cleared all 2 stale flags; real-world verification pending next notification burst
  - remaining_risk: Depends on global._lastSessions being populated by dashboard polling. If no dashboard is open for long periods, cleanup is effectively paused until next poll.
  - iteration_count: 1

## slice_003
name: project-path-detection-accuracy
status: verified
priority: medium
workflow: session-to-project-mapping
trigger: GET /api/sessions computes displayName for each session
expected_result: displayName reflects the actual project the Claude session is working on, never a conversation topic sentence
observed_result: Two sessions both displayed "Update tasting alliance landing page" from identical pane titles (BEFORE FIX). After fix: numeric sessions fall back to their number; named sessions use tmux name; pane titles only pass as single/dual-token non-verb identifiers.
root_cause: Method 4 (pane title) fired before Method 5 (tmux session name), and Method 4 accepted any non-hostname string — including full English sentences from Claude's conversation topic.
components:
  - server/server.js (Methods 1-6 priority chain)
contracts:
  - displayName should be a short project identifier, not a sentence
notes:
  - root_cause: Method ordering preferred pane title over tmux session name, and sentence-like titles were accepted
  - files_changed: server/server.js (lines 474-503)
  - fix: (1) Swapped Methods 4 and 5 — tmux session name now takes precedence over pane title. (2) New Method 5 (pane title) rejects sentence-like strings: >2 words, leading action verbs (Update/Fix/Add/Create/etc.), or trailing punctuation.
  - tests_added: live /api/sessions — sessions 0/2/4 (home-dir, numeric tmux names) correctly fall through to "0"/"2"/"4" when pane title is a sentence; named session "rpgclaw" keeps its tmux name with projectConfirmed=TRUE; session 0 with @matrix_project=vanguard picks up "vanguard" via Method 1.
  - remaining_risk: Short sentence-like project names ("my app", "new tool") would still get rejected as >2 words. Extend verb list as needed.
  - iteration_count: 1
