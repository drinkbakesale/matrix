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
status: pending
priority: high
workflow: notification-attention-cycle
trigger: Claude asks a question -> notification fires -> user dismisses or responds
expected_result: Attention clears when user responds or dismisses; does not re-fire for same question
observed_result: Multiple sessions showing needsAttention=true that likely shouldn't be
components:
  - server/server.js (pendingAttention, dismissedUntilChange, periodic cleanup)
  - server/public/app.js (dismiss/undismiss logic)
  - server/public/desktop.js (dismiss/undismiss logic)
contracts:
  - POST /api/dismiss clears attention
  - SSE notification events
tests_required:
  - Attention clears after dismiss
  - Attention does not re-fire for same question
  - Periodic cleanup catches sessions that are no longer idle
notes:
  - 5 of 8 displayed sessions show needsAttention=true — seems too many

## slice_003
name: project-path-detection-accuracy
status: pending
priority: medium
workflow: session-to-project-mapping
trigger: GET /api/sessions computes displayName for each session
expected_result: displayName reflects the actual project the Claude session is working on
observed_result: Scrollback scan picks up incidental path mentions; pane titles are conversation descriptions not project names
components:
  - server/server.js (Methods 1-7 priority chain)
contracts:
  - displayName should be a short project identifier, not a sentence
tests_required:
  - Session working on project X in ~/Projects/X gets displayName "X"
  - Session mentioning project Y in scrollback but working on X gets displayName "X"
notes:
  - Method 4 (scrollback scan) is the primary source of noise
  - Method 5 (pane title) returns full sentences like "Set up Figma API authentication"
  - Consider using Claude Code's working directory from CLAUDE.md or .claude/ presence
