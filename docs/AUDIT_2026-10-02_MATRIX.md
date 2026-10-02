# Matrix construction audit — 2026-10-02

**Yardstick.** Matrix is meant to be the *one* window the user works from: pick any running
Claude Code project, read it, type into it, on desktop or phone — instead of juggling iTerm
and tmux windows. Its second job is triage: at a glance, which projects need input, which are
stuck, which are working, which are idle.

**How to read the citations.** Every construction claim cites
`path:line @27534cd` — the line numbers are as of base commit
`27534cddc450dfb2003eb6c2733e543e5fda110d`, the revision this audit was written against. The
same build that produced this report (task `t-20261002-66103e3e`) split three oversized
entrypoints; where a cited block has moved, the new home is given in brackets. Claims are
labelled **[code]** (read from source), **[observed]** (measured on this machine, read-only),
**[harness]** (measured in a test harness, *not* live) or **[inference]**.

**This report implements none of its own proposals.** The only product changes in this build
are D2 (mobile copy) and D3 (session brief).

---

## 1. The construction as it actually is

### 1.1 Session discovery (tmux)

* `server/server.js:438-571 @27534cd` **[code]** `listLiveSessions()` shells
  `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_path}|#{session_activity}'`
  (`:444-447`), then per session `tmux list-windows` (`:454-457`) and `tmux list-panes`
  (`:468-471`), and `tmux show-option -v @matrix_project` (`:487-490`). Claude is detected by
  the pane command containing `claude` or matching `^\d+\.\d+\.\d+$` (`:474`).
  *[now `server/lib/sessions.js:52-130`]*
* `server/server.js:585-587 @27534cd` **[code]** `GET /api/sessions` re-runs the whole scan on
  every request. There is no cache for the route itself; a 5-second cache exists only for
  notification routing (`:575-582`).
* `server/server.js:559-563 @27534cd` **[code]** Sorting is already triage-flavoured:
  `needsAttention` first, then `projectConfirmed`, then `lastActivity` descending.
* `server/server.js:565-566 @27534cd` **[code]** The result is stashed on
  `global._lastSessions`/`global._lastSessionsAt`, which several other routes read.
  *[now `server/lib/attention.js`]*
* **[observed] 2026-10-02**, running the delivered listing code against this machine's real
  tmux server (read-only; `node -e "require('./server/lib/sessions.js').listLiveSessions()"`):
  **70 live sessions**, 27 with Claude running, **0 flagged `needsAttention`**, 18 of 70 with
  any description.

### 1.2 Project identity

* `server/lib/session-identity.js:54-74 @27534cd` **[code]** Evidence chain, strongest first:
  explicit `@matrix_project` tag → registry path match → non-home cwd basename → tmux session
  name. Pane titles are never identity (`:52-53`); they only feed a description
  (`:80-94`).
* `server/lib/session-identity.js:100-113 @27534cd` **[code]** `assignInstanceLabels()` keeps
  *every* live session and disambiguates shared projects with an instance suffix. Nothing is
  deduplicated away. This is the current, deliberate policy.
* `server/lib/session-identity.js:119-152 @27534cd` **[code]** `resolveNotificationTarget()`:
  a hook-supplied tmux session is authoritative; a label resolves only when exactly one live
  confirmed session matches; ambiguity resolves to *no* target.
* `hooks/matrix-project-tag.js:2-4,115-150 @27534cd` **[code]** A PostToolUse hook watches
  `file_path` in tool calls and sets `@matrix_project` on the tmux session. It fires only on
  file tool activity, so a session that has not touched a file yet has no tag.
* **[observed] 2026-10-02** Of the 70 live sessions, **10** resolve by explicit tag and
  **60** fall through to `source: 'fallback'` with `projectConfirmed: false` — i.e. 60 rows are
  named by a bare tmux number. **8** sessions share one project (`angles-to-ads`).
  **0** rows are labelled `williamkehler`.

### 1.3 Transport (WebSocket, `output` vs `screen`, scrollback)

* `server/server.js:967-1143 @27534cd` **[code]** One WebSocket per open terminal,
  `?session=&window=`; the window is auto-detected as the one running Claude (`:978-990`).
  *[now `server/lib/pane-stream.js`]*
* `server/server.js:1018-1027 @27534cd` **[code]** `captureAll()` runs
  `tmux capture-pane -p -S -` with a 64 MiB buffer — and **swallows every failure into an
  empty string**. The 100 ms poller then sees a shorter capture and simply stops advancing;
  the user sees a terminal that quietly stops updating. This build deliberately leaves that
  behaviour exactly as it was when extracting the code to `server/lib/pane-stream.js`:
  fixing it is improvement 3 below, a separate change with its own evidence, not something
  an extraction should smuggle in.
* `server/server.js:1040-1048 @27534cd` **[code]** Every connection, including an automatic
  reconnect, re-sends the whole scrollback as the first `output`.
* `server/server.js:1054-1096 @27534cd` **[code]** The 100 ms poll sends `output` when the
  capture grew, and `screen` (the last `rows` lines) when the length is unchanged but the
  content differs. The comment at `:1029-1031` ("We NEVER clear the screen. We only APPEND")
  describes the *server*, not the client: the client treats `screen` as a replaceable block.
* `server/public/app.js:581-603 @27534cd` **[code]** On `screen`, the client removes the
  existing `.msg-screen` node and appends a new one — i.e. the node under the user's finger is
  destroyed roughly ten times a second. *[now `server/public/matrix-transcript.js`]*

### 1.4 Input path

* `server/server.js:1102-1120 @27534cd` **[code]** WebSocket `input` is hex-encoded and sent
  with `tmux send-keys -H`, then attention is cleared for the session and its display-name
  variants.
* `server/server.js:613-633 @27534cd` **[code]** `POST /api/send` is the non-WebSocket path
  (`tmux send-keys … Enter`).
* `server/public/app.js:757-772, 889-908 @27534cd` **[code]** Mobile text input plus
  quick-action buttons (`y/n/1/2/3/enter/esc`). `server/public/desktop.js:367-386 @27534cd`
  is the desktop equivalent, with slash-command autocomplete (`:393-443`).

### 1.5 Notifications

* `bin/matrix-notify:9-12,69-73 @27534cd` **[code]** The notifier resolves its own tmux session
  from `$TMUX_PANE`, reads `@matrix_project`, and POSTs
  `{message, project, session, tmuxSession}` to `/api/notify`.
* `server/server.js:159-215 @27534cd` **[code]** `/api/notify` resolves one live tmux target,
  suppresses a repeat of a dismissed message (`:179-184`), records a pending alert, sets
  `pendingAttention`, fans out over SSE and calls `sendPush`. *[now
  `server/lib/notify-routes.js`]*
* `server/server.js:86-104 @27534cd` **[code]** `sendPush` embeds the resolved
  `targetSession` in the push payload and prunes 404/410 subscriptions.
* `server/public/sw.js:19-36 @27534cd` **[code]** The service worker shows the notification
  with `data.targetSession`; `:38-41` builds `/?open=<targetSession>`; `:44-66` focuses an
  open client and posts `{type:'open-session', targetSession}`, otherwise opens that URL.
* `server/public/app.js:163-214 @27534cd` **[code]** The client's navigation-intent
  arbitration: generations, priorities and a re-check immediately before the terminal action,
  so a late pending-alert response cannot overwrite a tap.
* `server/public/sw.js:14-17 @27534cd` **[code]** `fetch` is network-first with no cache, so
  the PWA has no offline shell.

### 1.6 Build inbox

* `server/lib/build-inbox.js:92-120 @27534cd` **[code]** `runBuildInbox()` spawns a fixed
  `buildctl inbox --json` through `execFile` (no shell), bounded by timeout and `maxBuffer`,
  and classifies failures (`:80-90`). It is strictly read-only — no controller actions.
* `server/server.js:1296-1312 @27534cd` **[code]** `GET /api/build-inbox` coalesces concurrent
  requests into one in-flight call and maps errors to a status/body (`buildInboxErrorResponse`,
  `server/lib/build-inbox.js:126`).
* `server/public/app.js:659-753 @27534cd` **[code]** A pinned "Build Inbox" row on mobile
  opens a separate view with three groups; every controller string is assigned through
  `textContent`. *[now `server/public/app-panels.js`]* There is **no desktop equivalent**
  (`server/public/desktop.js @27534cd` has no `build-inbox` reference).

### 1.7 Desktop vs mobile clients

* Two independent renderers with duplicated logic: `escapeHtml`/`sessionLabel`
  (`app.js:11-22` ≡ `desktop.js:10-21`), `stripAnsi`/`filterStatusLines`
  (`app.js:490-511` ≡ `desktop.js:25-43`), and two separate stream handlers
  (`app.js:568-605`, `desktop.js:323-349`). **[code]**
* `server/public/desktop.js:334-347 @27534cd` **[code]** The desktop `screen` path had **no**
  selection guard at all — it removed and re-appended `.msg-screen` unconditionally.
* `server/public/desktop.js:530-538 @27534cd` **[code]** Desktop already has one quick-switch:
  `Ctrl+1…9` selects the Nth row of the current sort order. There is no palette, no search,
  and no indication anywhere in the UI that the shortcut exists.
* `server/public/desktop.js:240-246,211-237 @27534cd` **[code]** A "needs your input" toast
  with `Enter to switch`. Mobile's equivalent is `app.js:216-236`.
* `server/public/style.css:553-583 @27534cd` **[code]** `#terminal` and `#terminal .msg`
  already set `user-select: text` and `-webkit-touch-callout: default`.
  `server/public/desktop.css:303-330 @27534cd` **[code]** does **not**.

### 1.8 Services

* **[observed] 2026-10-02**, `launchctl list` and
  `launchctl print gui/501/com.claude-remote.app`: `com.claude-remote.app` is **loaded and
  running** (PID 48246) as
  `/opt/homebrew/bin/node /Users/williamkehler/Projects/matrix/server/server.js` — the live
  server really is this checkout, as the request states. Also loaded: `com.matrix.console`
  (last exit 1, not running), `com.claude-remote.autostart` (last exit 1, not running),
  `com.matrix.whisper-server` (running), `com.matrix.ptt-daemon` (running), `com.matrix-pedal`.
  Two different plists (`com.claude-remote.app`, `com.matrix.console`) both want port 7778;
  only one can win, and `com.matrix.console` is the one that keeps failing.
* `install.sh:247-275 @27534cd` **[code]** The installer writes a *third* agent,
  `com.matrix-console.autostart`, which matches none of the loaded labels above.
* The repository tracks only `launchagents/com.matrix.ptt-daemon.plist` and
  `launchagents/com.matrix.whisper-server.plist`; **no `com.claude-remote.*` plist is in the
  repo** — the running configuration is untracked. **[code]**
* `bin/matrix-app:1-20 @27534cd` **[code]** A PID-file start/stop wrapper, independent of all
  of the above.

### 1.9 Tests (as of base)

62 tests across 10 files, all source-driven: `tests/terminal-reconnect.test.js` and
`tests/client-navigation.test.js` cut named regions out of `app.js` and run them in a VM;
`tests/navigation-intents.test.js` runs the whole client; `tests/app-harness.js` is a DOM
stand-in with no layout, no `Selection` and no clipboard; `tests/source-text.test.js` only
checks for control bytes. **[code]** There was no browser, no WebKit and no clipboard test —
which is exactly how task `t-20260915-dc0b9ba0` could pass "native touch text selection/copy"
on static checks while the feature did not work.

---

## 2. Judged against the purpose

### 2.1 (a) One window to switch between projects and work in them

| Gap | Evidence | Why it hurts |
|---|---|---|
| The list is 70 rows and 60 of them are bare numbers | **[observed]** §1.2; `session-identity.js:69-73 @27534cd` returns the raw tmux name when nothing confirms a project | You cannot pick a project from a list of numbers; the one-window promise fails at the first step |
| Eight rows for one project, indistinguishable | **[observed]** 8 × `angles-to-ads`; suffix is the tmux number (`session-identity.js:102-112 @27534cd`) | Correct policy (each session must stay addressable) with no useful discriminator — see §4.7 |
| Only 18/70 rows say anything about the work | **[observed]**; `server.js:503-529 @27534cd` derives a description from `projects.conf`, `package.json`/`README`, or a pane title | Choosing a window is guesswork |
| No search, no palette, no mobile quick-switch | `desktop.js:530-538 @27534cd` is `Ctrl+1-9` only; `app.js` has no shortcut | At 70 rows, `Ctrl+1-9` reaches 9 of them, in a sort order that changes under you |
| Selecting and copying transcript text on mobile did not work | **[harness]** `tests/acceptance/browser.mjs → Copy::diagnosis_and_base_failure`: on base, the node under the finger is removed from the DOM within the 900 ms long-press window (`stable:false`, `connected:false`) and a reconnect dump wipes an established selection | Reading is only half of "work in it"; getting text *out* was impossible |
| Whole-screen churn ten times a second | `server.js:1072-1082 @27534cd` + `app.js:581-603 @27534cd` | Everything downstream (selection, scroll, focus) fights the stream |
| Desktop and mobile are separate implementations | §1.7 | Every fix has to be made twice and one half silently rots (desktop had no selection guard at all) |

### 2.2 (b) Knowing what needs input or is stuck

| Gap | Evidence | Why it hurts |
|---|---|---|
| There is no state model — only a boolean | `server.js:531-533 @27534cd` sets `needsAttention` purely from `pendingAttention`, which only a notification writes (`:196-200`) | "Working", "idle", "errored" and "stuck" are not represented anywhere |
| "Needs input" depends on a hook firing, not on observation | `bin/matrix-notify` → `/api/notify`; no polling path ever sets attention | A session that stopped without a notification is indistinguishable from one that is working |
| **[observed]** 0 of 70 sessions flagged, with 27 Claudes running | §1.1 | The triage view is, in practice, empty |
| The one heuristic that exists only *clears* flags | `server.js:1183-1194 @27534cd` looks for spinner/progress glyphs every 10 s and clears attention | The same evidence could set state, and does not |
| "Stuck" is not defined anywhere | no occurrence of `stuck` in the repository | Nothing can be sorted or badged by it |
| No counts, no badges, no attention total | `app.js:355-375 @27534cd` renders a per-row badge only | You must scan 70 rows to find the one that needs you |
| Attention is keyed by three different strings | `server.js:1156-1164 @27534cd` prunes orphans across `name`/`displayName`/lowercase | Fragile; a key mismatch loses the only triage signal there is |
| The build inbox is mobile-only and never surfaces counts | §1.6 | Builds waiting on the user are invisible on the desktop client |

---

## 3. Ranked improvements to what already exists

Effort: **S** ≲ half a day, **M** ≈ 1–3 days, **L** > 3 days.

1. **Give the 60 unidentified sessions a name.** *Problem:* 86 % of rows are bare numbers.
   *Evidence:* **[observed]** §1.2; `session-identity.js:69-73 @27534cd`. *Change:* extend the
   evidence chain with (a) the pane's current working directory even when it equals `$HOME`
   but a Claude Code project directory matches, and (b) a `@matrix_project` backfill written
   when a session is first *seen* by Matrix rather than only when the hook sees a file edit.
   *Effort:* M. *Risk:* medium — identity changes can re-route notifications; must keep
   `resolveNotificationTarget` behaviour and its tests green.
2. **Make `GET /api/sessions` cheap.** *Problem:* each request runs ~4 `tmux` calls per session
   — at 70 sessions that is ~280 subprocesses, and the desktop polls every 5 s
   (`desktop.js:981 @27534cd`). *Evidence:* `server.js:438-499 @27534cd`. *Change:* one batched
   `list-panes -a` plus a short TTL cache shared with `global._lastSessions`. *Effort:* S.
   *Risk:* low; covered by existing identity tests.
3. **Stop swallowing `capture-pane` failures.** *Problem:* a failed capture becomes `''` and the
   terminal silently freezes. *Evidence:* `server.js:1018-1027 @27534cd`. *Change:* propagate
   the error, count it, and send an explicit `stream-error` frame the client renders.
   *Effort:* S. *Risk:* low.
4. **One shared client core.** *Problem:* duplicated ANSI/label/stream logic, and desktop
   lagging behind mobile. *Evidence:* §1.7. *Change:* this build extracted the transcript,
   copy and brief surfaces into `server/public/matrix-*.js`; finish the job for
   `escapeHtml`/`sessionLabel`/session-list rendering. *Effort:* M. *Risk:* medium — two HTML
   bootstraps to keep in the right order.
5. **Put the build inbox on the desktop too.** *Problem:* mobile-only. *Evidence:* §1.6.
   *Change:* reuse `renderBuildInbox` from the shared core in a sidebar section. *Effort:* S.
   *Risk:* low (read-only endpoint).
6. **Reconcile the launchd services.** *Problem:* three competing definitions, two of them
   failing, none of the running one tracked. *Evidence:* **[observed]** §1.8 and
   `install.sh:247-275 @27534cd`. *Change:* track `com.claude-remote.app.plist`, make
   `install.sh` write exactly that label, and remove the other two. *Effort:* S.
   *Risk:* medium — out of scope for this build (`R-operations` forbids service changes);
   must be done deliberately, with the user present.
7. **Make the description field earn its row.** *Problem:* 18/70 rows have one, and it is
   often a stale `README` line. *Evidence:* **[observed]** §1.1; `server.js:683-715 @27534cd`.
   *Change:* prefer the new per-session brief (D3) over `detectDescription()` for live
   sessions. *Effort:* S. *Risk:* low. See §4.7.

---

## 4. Suggested features

### 4.1 An explicit per-session state model *(mandatory evaluation)*

*User problem:* "which of my projects need my input or are stuck?" has no answer today (§2.2).
*Sketch:* the server computes one of `needs-input | working | idle | errored | stuck | unknown`
per session each poll, from three signals that already exist — hook events
(`pendingAttention`), output inactivity (the pane capture the stream already takes), and the
spinner/progress scan at `server.js:1183-1194 @27534cd` — and returns it as `state` plus
`stateSince` alongside the existing fields.

**Measurable rule for `stuck`** (proposed, deliberately conservative):

> A session is `stuck` when **all** of: (1) its last `turnStarted` signal is more recent than
> its last `turnEnded` signal — i.e. a turn is open; (2) the pane capture has been
> byte-identical for **≥ 180 s**; (3) the last captured non-blank line does not match the
> waiting-for-user pattern (a prompt box, `(y/n)`, a numbered choice, `Do you want`); and
> (4) no spinner or progress glyph appeared in that window
> (the predicate at `server.js:1189-1190 @27534cd`).
>
> Exclusions: `needs-input` wins over `stuck` (rule 3); a session with no Claude process is
> `idle`, never `stuck`; a session whose pane cannot be captured is `unknown`, never `stuck`;
> a session younger than 180 s is `unknown`.
>
> False-positive trade-off: 180 s will mislabel a long single tool call (a large build, a
> slow test run) as stuck. The alternative — raising the threshold to ~10 min — makes the
> state useless for the user's actual question. Recommendation: ship 180 s as **a sort key and
> a badge only, never as a notification**, and log `stuck→resolved` transitions so the
> threshold can be calibrated on real data before it is allowed to page anyone.

*Effort:* M. *Dependencies:* the capture already runs for open sessions only; a cheap
`capture-pane -S -5` per session per poll is needed for closed ones (improvement 2 first).

### 4.2 Triage-sorted list, badges and attention counts *(mandatory)*

*User problem:* 70 rows, nothing to scan for. *Sketch:* group the list by state
(`Needs you` / `Stuck` / `Working` / `Idle`), put a count on each group header and a total in
the app header and the PWA badge (`navigator.setAppBadge`). The sort at
`server.js:559-563 @27534cd` becomes a state ordering; the existing mobile swipe-to-snooze
(`app.js:386-429 @27534cd`) keeps working as the "I know, later" control.
*Effort:* S on top of §4.1. *Dependencies:* §4.1.

### 4.3 Notifications that deep-link to the exact session *(mandatory)*

*Current construction:* the chain is complete in source — resolved target
(`session-identity.js:119-152 @27534cd`) → payload (`server.js:88 @27534cd`) → notification
data (`sw.js:19-36`) → focus+postMessage or `/?open=` (`sw.js:44-66`) → client arbitration
(`app.js:163-214 @27534cd`).

**Verification status — explicitly unverified live.** Tests
`tests/sw-routing.test.js`, `tests/navigation-intents.test.js` and
`tests/notify-to-terminal.test.js` are **[harness]** results: they run the service-worker and
client code in a VM with stub globals. They are *not* evidence that a real APNs push, on the
installed iOS Home-Screen PWA, opens the right session. This build could not establish that:
sending a real push would mean delivering an unsolicited external notification, which
`R-operations` forbids, and this session's tooling additionally blocked HTTP requests to the
live server (`http://localhost:7778`), so even the read-only `/api/sessions` response could
not be captured. **Do not claim the t-20260915 deep-link fix works live.** What *is*
**[observed]** is only that the service is running from this checkout (§1.8) and that
`~/.matrix/vapid.json` exists, so push is configured.

*Safe verification procedure, at deploy time, with the user present:*
1. On the phone, open the Home-Screen PWA and confirm the push-setup banner is gone
   (`app.js:240-282 @27534cd`).
2. On the Mac: `tmux list-sessions` and pick two sessions of the *same* project — the case
   that used to misroute.
3. For the first, run
   `TMUX_PANE=$(tmux list-panes -t <session> -F '#{pane_id}' | head -1) bin/matrix-notify "audit deep-link test 1"`.
   This is a real notification the user is expecting, addressed to themselves.
4. Background the PWA, tap the notification, and confirm the terminal that opens is that exact
   tmux session (check `#term-title` against the session's project and suffix).
5. Repeat for the second session of the same project. Both must land on their own terminal.
6. To see *why* it routed as it did, capture the `/api/notify` reply directly — it is the only
   place `via` appears. `bin/matrix-notify:71-74 @27534cd` pipes curl's output away, and
   `/api/notify` (`server.js:208-214 @27534cd`, now `server/lib/notify-routes.js`) logs
   nothing, so **`via` is not in `~/.matrix/logs/matrix.log` and never was**. Post the same
   body the hook posts and read the response:
   ```sh
   S=<session>
   curl -s -X POST http://localhost:7778/api/notify \
     -H 'Content-Type: application/json' \
     -d "{\"message\":\"audit deep-link test\",\"project\":\"$S\",\"session\":\"$S\",\"tmuxSession\":\"$S\"}"
   ```
   The JSON reply carries `targetSession` and `via`: `tmux-session` is the good path;
   `project`, `ambiguous-label` or `unresolved` each mean the hook is not passing
   `tmuxSession`. Note this sends a real notification, so do it only in the same sitting as
   steps 3-5. To learn `via` without any notification at all, add a one-line
   `console.log` of `target.via` to the route first — that is a code change, not part of
   this procedure.

*Effort to fix if it fails:* unknown until step 6 identifies `via`. *Dependencies:* none.

### 4.4 Quick-switch *(mandatory)*

*User problem:* picking one of 70 projects. *Sketch:* desktop — `Cmd/Ctrl+K` opens a palette
over the sidebar, fuzzy-matching project name, tmux name and (new) the D3 brief, `Enter`
selects, `↑/↓` moves, and the existing `Ctrl+1-9` (`desktop.js:530-538 @27534cd`) is relabelled
in the row so it is discoverable. Mobile — a sticky filter field above `#sessions` plus
horizontal swipe between the last two sessions. *Effort:* M (desktop S, mobile M, because the
swipe must not collide with swipe-to-snooze at `app.js:386-429 @27534cd` or with the
transcript gesture protection added by D2). *Dependencies:* §4.2 for a stable ordering.

### 4.5 Launching a new project session from Matrix *(mandatory)*

*This already exists.* `POST /api/projects/start` creates the tmux session, launches
`claude --dangerously-skip-permissions` and opens a second `shell` window
(`server.js:907-932 @27534cd`); mobile reaches it through the `+` picker
(`app.js:433-481 @27534cd`) and desktop through both the "Start a New Project" form
(`desktop.js:744-821 @27534cd`) and a click on a faded Recent row (`desktop.js:174-192`).
Candidate projects come from `/api/projects/inactive` (`server.js:833-904`), which merges
`projects.conf` with `~/.claude/projects/` history. *Remaining gaps:* the project path is
free text with no existence check (`server.js:908-909`); the hard-coded
`--dangerously-skip-permissions` is not a choice the user is shown; the mobile picker hardcodes
`/Users/williamkehler/` when shortening paths (`app.js:462 @27534cd`); and a start is
fire-and-forget with a 2 s `setTimeout` rather than a readiness check
(`app.js:478`, `desktop.js:186-189`). *Sketch:* validate the path, show the flags that will be
used, and poll `/api/sessions` until the session appears instead of sleeping. *Effort:* S.
*Dependencies:* none. **Not implemented by this build.**

### 4.6 `buildctl inbox` for builds waiting on the user *(mandatory)*

*Current:* read-only and mobile-only (§1.6). *Sketch:* fold `counts.needsYou` into the same
attention total as §4.2 so one number answers "does anything want me?", render the same panel
on desktop, and poll it on the same cadence as the session list. Keep it strictly read-only —
no approve/reject/retry from Matrix; the controller owns those. *Effort:* S.
*Dependencies:* §4.2; `buildctl` present at `MATRIX_BUILDCTL`.

### 4.7 The session brief as a triage signal *(suggestion only — not part of D3)*

D3 produces, per session, a one-line "what this session is doing right now", derived from that
session's own pane and refreshed on a 30 s evidence interval
(`server/lib/brief-service.js`, `server/lib/brief-evidence.js`). The same string is the
missing discriminator everywhere the audit found a gap: it is a far better row subtitle than
`detectDescription()` (improvement 7), it is what tells eight `angles-to-ads` rows apart
(§2.1), and it is the natural search corpus for the §4.4 palette. *Sketch:* add
`brief.current` to the `/api/sessions` payload for sessions whose brief is already cached —
never generating on the list path — and render it where `session-desc` is today
(`app.js:361-363 @27534cd`). *Effort:* S. *Dependencies:* D3 shipped; §4.2 for the layout.
**This build deliberately does not do it:** the list integration is a suggestion, and it
would mean a model-derived string influencing a triage view, which the contract keeps out.

---

## 5. Known open issues accounted for

* **`docs/HANDOVER_matrix_dedup.md` is absent.** It does not exist at base
  `27534cd`, is not in the working tree, and `git log --all -- docs/HANDOVER_matrix_dedup.md`
  returns nothing. Its contents are **not** reconstructed here. The three issues the request
  quotes from it are addressed from live evidence instead:
  * *rows labelled `williamkehler`* — **[observed]** 0 of 70 rows today. The guard is
    `session-identity.js:61` (a cwd whose basename is the username counts as "at home") and
    `:80-94` (a pane title equal to the username/host/folder describes nothing). Considered
    resolved, with a live measurement rather than a claim.
  * *duplicate rows for one project* — **[observed]** still present and expected: 8 live
    sessions share `angles-to-ads`. Current policy is deliberate
    (`session-identity.js:100-113 @27534cd`): never merge, disambiguate instead. The real
    defect is that the disambiguator is a meaningless number — §4.7.
  * *identity policy undecided* — it is now decided in code and tested
    (`tests/session-identity.test.js`): explicit tag > registry > cwd > session name, pane
    titles never identity. This audit does not reopen it; improvement 1 extends the chain
    without changing its order.
* **`docs/stabilization-slices.md`** is historical evidence and now **conflicts with the
  code**. `slice_001:9-14` describes dedup logic ("Dedup only merges sessions where BOTH have
  `projectConfirmed=true`") that no longer exists — there is no dedup in
  `session-identity.js @27534cd` at all. `slice_003:48-60` describes a six-method `displayName`
  chain that has since become the four-step evidence chain. `slice_002`'s own
  `remaining_risk` ("cleanup is effectively paused until the next poll") is still true:
  `server.js:1150-1154 @27534cd` returns early when `global._lastSessions` is empty. Treat the
  file as a changelog, not as a description of the system; §4.1 supersedes `slice_002`.

---

## 6. Deployment and verification status

* **[harness], not live:** every Copy, Brief and BriefService result in this build comes from
  Playwright WebKit/Chromium against a loopback fixture server with a stubbed WebSocket, a fake
  tmux and an injectable clock. Desktop WebKit has no SpringBoard, no native iOS selection
  handles and no OS share sheet; a programmatic `display-mode: standalone` is **not** an
  installed iOS PWA. The mandatory native long-press attempt is recorded honestly in
  `copy-diagnosis.json` / the `nativeLongPress` note, including that WebKit has no
  constructible `Touch`.
* **[observed], live:** the launchd/tmux facts in §1.8 and §1.1–§1.2 only.
* **Unverified, and not claimed:** real APNs delivery, the installed-PWA deep link (§4.3), and
  the accuracy of the opt-in `claude`-CLI brief generator on real transcripts. The shipped
  default brief generator is extractive and was measured on the frozen eight-record corpus
  (6/6 useful, 2/2 abstentions, 0 unsupported clauses) — that is a fixed synthetic corpus, not
  a production accuracy estimate.
* **Nothing was deployed or restarted.** The user deploys.

---

## 7. Recommended next three builds

1. **Session state + triage list** (§4.1 + §4.2, with the 180 s `stuck` rule shipped as a
   badge and sort key only). This is the single thing that turns 70 numbered rows into an
   answer to "what needs me?", and everything else in §4 depends on the ordering it defines.
   Effort M. Prerequisite: improvement 2 (batch the tmux calls), or the extra polling will
   make the list slower than it already is.
2. **Live notification verification, then whatever it reveals** (§4.3). Run the six-step
   procedure above *before* building anything on top of notifications. It is an hour of work
   and it either retires the oldest open risk in the product or tells you exactly which link
   in the chain is broken. Effort S for the check; the fix is unscoped until step 6.
3. **Identity and labels** (improvement 1 + §4.7 + §4.4 desktop palette). With state solved and
   notifications trusted, the remaining barrier to one-window working is that you cannot tell
   the rows apart or jump to one. Effort M.
