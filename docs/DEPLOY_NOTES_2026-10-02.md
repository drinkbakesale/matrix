# Deployment notes — 2026-10-02 (mobile copy + session brief)

Nothing in this build was deployed. The live `com.claude-remote.app` LaunchAgent was not
restarted, no tmux session was created, killed or written to, no hook or launchd plist was
touched, and no notification was sent. **You deploy.**

## What changed

* **Mobile/desktop transcript copying (D2).** One shared controller now owns every `#terminal`
  mutation (`server/public/matrix-transcript.js`). Protection starts at pointer/touch **down**
  — before any selection exists — so the node under your finger survives the iOS long-press
  window; incoming output and screen frames are staged outside the DOM and applied when the
  gesture settles. A plainly visible **Select / copy** control above the transcript opens a
  frozen, selectable plain-text snapshot with **Select all / Copy selection / Copy all /
  Resume live / Close** (`server/public/matrix-copy.js`). A copy only ever reports success
  after the clipboard write actually succeeded; a denied or unavailable clipboard shows an
  actionable error and keeps the snapshot.
* **Pinned session brief (D3).** Two labelled lines — project goal and what this session is
  doing now — pinned above the transcript on both clients, with freshness, collapse, and a
  per-field **Edit** / **Clear edit** that persists until you clear it
  (`server/public/matrix-brief.js`, `server/lib/brief-*.js`,
  `GET|PATCH /api/sessions/:name/brief`).
* **File split.** `server/server.js`, `server/public/app.js` and `server/public/desktop.js`
  were split into cohesive modules so every touched file stays under 500 lines. Behaviour was
  preserved; the existing 62 tests still pass (63 now — one was added).

## To deploy

```bash
cd ~/Projects/matrix
git pull                       # or merge the candidate branch
launchctl kickstart -k gui/$(id -u)/com.claude-remote.app
```

Hard-reload the PWA afterwards (the service worker is network-first, but the HTML is cached by
Safari): on the phone, close and reopen the Home-Screen app; on desktop, Shift-reload.
No migration is needed. New state lives in `~/.matrix/briefs.json` (versioned JSON, `0600`,
atomic writes); deleting it loses only generated text and your brief edits.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MATRIX_BRIEF_GENERATOR` | `extractive` | `claude` switches to the installed `claude` CLI |
| `MATRIX_BRIEF_MODEL` | `claude-haiku-4-5-20251001` | only used by the `claude` generator |
| `MATRIX_CLAUDE_BIN` | `claude` | path to the CLI |
| `MATRIX_BRIEF_INTERVAL_MS` | `30000` | evidence re-check interval per open session |

The default **extractive** generator only ever shows text that literally appears in that
session's own pane, so it cannot invent a goal — and when the pane does not say what the work
is, it says "No brief yet" rather than guessing. Setting `MATRIX_BRIEF_GENERATOR=claude` runs
the installed CLI non-interactively (`-p --tools "" --strict-mcp-config
--no-session-persistence`, prompt on stdin, no shell, no API key, 30 s bound, isolated cwd).
It will usually read better on real transcripts.

## Running the tests

The runtime dependency graph is untouched: `package.json` and `package-lock.json` are
byte-identical to the base commit, so deploying installs nothing new. The browser acceptance
runners need Playwright, which is pinned **outside** the runtime manifest in a private
`tests/acceptance/package.json` with its own small lockfile, so it can never end up in a
production install.

```sh
npm ci                                  # runtime deps, unchanged
node --test --test-reporter=tap tests/*.test.js   # the fast suite, no browser needed

npm ci --prefix tests/acceptance        # test-only: playwright 1.59.1, locked
npm --prefix tests/acceptance run engines         # downloads the pinned WebKit + Chromium
node tests/acceptance/service.mjs --oracle <oracle_dir> --artifacts <dir> --result <dir>/service.json
node tests/acceptance/browser.mjs --oracle <oracle_dir> --artifacts <dir> --result <dir>/browser.json
```

Every acceptance runner resolves Playwright from `tests/acceptance/node_modules`, never from
the repository root. Do not run any of this in the live `~/Projects/matrix` checkout.

## Limitations you should know about

* **The `claude` generator's accuracy is not measured.** The 6/6 useful-summary, 2/2
  abstention, 0 unsupported-clause result in `brief-corpus-report.json` is the **extractive**
  generator on a fixed eight-record synthetic corpus. It is not a production accuracy
  estimate, and it says nothing about the CLI path, which cannot be evaluated offline. If you
  enable the CLI generator, treat its first days as a calibration period and use the **Edit**
  control when it is wrong.
* **The copy fix was proven in desktop WebKit, not on your phone.** Playwright's WebKit has no
  SpringBoard, no native iOS selection handles and no OS share sheet, and a programmatic
  `display-mode: standalone` is not an installed PWA. What *is* proven: on the frozen base the
  node under the finger is destroyed inside the 900 ms long-press window and on the candidate
  it is not; the snapshot and its selection survive ≥ 3 s of streaming, a reconnect and a
  brief refresh; and a real clipboard round-trip (paste into an independent destination in
  WebKit, `navigator.clipboard.readText()` in Chromium) returns the exact text. **Please try a
  real long-press on the phone after deploying** — if iOS still will not give you handles, the
  **Select / copy** control is the path that is tested end to end.
* **The t-20260915 notification deep link is still unverified live.** See
  `docs/AUDIT_2026-10-02_MATRIX.md` §4.3 for the six-step procedure to check it safely. This
  build sent no notifications.
* **Three launchd agents want port 7778** (`com.claude-remote.app` running,
  `com.matrix.console` and `com.claude-remote.autostart` both failing). This build did not
  touch them; see audit improvement 6.

## Rollback

`git revert` the merge and `launchctl kickstart -k gui/$(id -u)/com.claude-remote.app`.
`~/.matrix/briefs.json` is additive and ignored by the previous version.
