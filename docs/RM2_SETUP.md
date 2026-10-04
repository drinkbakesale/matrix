# Matrix on the reMarkable 2, with iPad control

What this gives you:

- **RM2** shows your sessions as rows and the selected session as a digest (state, your last prompt, Claude's last
  complete message, any pending question, files changed). It repaints only when something changes, never while Claude
  streams. Tap a row to select it.
- **iPad** keeps the keyboard and mouse. *Matrix Control* (`/control/`) is where you type; the text is echoed on the RM2
  and sent only when you press Send. It also sends the iPad a notification when a session needs input, finishes or is
  stuck.
- Sessions live in tmux on the Mac. Losing a connection loses nothing; both devices say plainly when they are stale or
  disconnected.

> **Nothing in this guide has been run on a physical RM2, iPad or travel router by the build that produced it.** The
> last section lists exactly what was verified on the Mac and what you verify on the hardware.

## 1. Mac (once)

```bash
cd ~/Projects/matrix
scripts/matrix-eink install-hook     # adds the evidence hook to ~/.claude/settings.json; other hooks untouched
scripts/matrix-eink setup-tls --bind <this Mac's LAN address>   # e.g. 192.168.68.63; creates the pinned certificate and
                                     # records the ONE address the RM2 listener may use
matrix-app stop && matrix-app start  # Matrix now also listens on <that address>:7779 (TLS, e-ink API only)
scripts/matrix-eink status
```

- The hook only observes (it prints nothing and cannot approve or block anything). A Claude session picks it up when it
  next starts. Until a session has produced a hook event, its row says so ("No Claude evidence is bound…") instead of
  guessing a state.
- Undo: `scripts/matrix-eink uninstall-hook` removes only the entries it added.

### Who can reach what

| Listener | Bound to | Serves | Reachable from |
|---|---|---|---|
| RM2 listener, port 7779, TLS | exactly the private address in `~/.matrix/eink/listen.json` | e-ink API only, token required | devices on that LAN subnet |
| Matrix, port 7778 (unchanged) | every interface, as before | legacy views everywhere; **e-ink API and pairing only for connections arriving on loopback** | the hook on this Mac; the iPad through Tailscale Serve (which connects over loopback) |

- The RM2 listener refuses to start on `0.0.0.0`, `::`, IPv4-mapped forms of those, any public address, an address
  this Mac does not have, or with no address configured. Matrix logs the reason
  (`E-ink LAN endpoint not started: …`) and keeps running. IPv6: only unique-local (`fc00::/7`) or `::1` are accepted.
- Verify after every restart:
  `grep 'E-ink LAN endpoint' ~/.matrix/logs/*.log | tail -1` must show `on <LAN address>:7779 only`;
  `lsof -nP -iTCP:7779 -sTCP:LISTEN` must show that address, not `*:7779`;
  from another device on the LAN, `curl -s -o /dev/null -w '%{http_code}' http://<LAN address>:7778/api/eink/v1/snapshot` must print `403`.
- Firewall: no change is needed and none is made. If the macOS firewall is on (System Settings → Network → Firewall),
  allow incoming connections for `node` when asked; do not turn the firewall off. On the router, forward **no** port to
  7778 or 7779: that is what keeps both unreachable from the internet. Check with a phone on mobile data (Wi-Fi off):
  `https://<your public IP>:7779` must not connect.
- The Mac's LAN address changed? `scripts/matrix-eink setup-tls --bind <new address>`, restart Matrix, and run
  `rm2-install install` again with the new `--url`.
- Roll back: delete `~/.matrix/eink/listen.json` and restart Matrix; the RM2 listener stays closed.

## 2. iPad

1. Install **Tailscale** on the iPad and sign in to the same tailnet as the Mac.
2. On the Mac, make Matrix reachable over private HTTPS (tailnet only — this is *Serve*, never *Funnel*):
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 7778`
   It prints the name, e.g. `https://<mac-name>.<tailnet>.ts.net`.
3. On the iPad open `https://<mac-name>.<tailnet>.ts.net/control/` in Safari.
4. On the Mac run `scripts/matrix-eink pair-code`; type the code into the page (works once, 10 minutes).
5. Share → **Add to Home Screen**. Open *Matrix Control* from the Home Screen, then drag it into the **Dock** so it is
   one tap (or ⌘-Tab) away from whatever else you are doing. *Matrix* at the top of the page returns to the normal views.
6. Tap **Enable notifications on this device** and allow. Web Push on iPad works only from the Home Screen app
   (iPadOS 16.4+). The line next to the button always says what is wrong:
   - *not installed to Home Screen* → do step 5 and open it from there;
   - *Permission: denied* → Settings → Notifications → Matrix Control → allow, then tap the button again;
   - *Mac: VAPID keys are not configured* → run `npm run setup` in the Matrix folder and restart Matrix;
   - *Mac: subscription … expired* → tap the button again.
7. Test: in any Claude session, ask something that makes Claude ask a question. The iPad should notify; tapping the
   notification opens Control on that session.

Typing: Enter is a new line; **⌘/Ctrl + Enter** or the Send button sends. Pending questions show their choices as
buttons; the key row (Esc, Enter, arrows, digits, Ctrl-C) covers prompts Control does not recognise.

## 3. RM2

Requirements: reMarkable 2 on software **3.28** (the installer checks the exact version and refuses anything else),
developer mode / SSH enabled, the tablet connected by USB (address `10.11.99.1`) or on Wi-Fi.

```bash
ssh-copy-id root@10.11.99.1         # first time only: compare the host fingerprint and accept it, then enter the
                                    # tablet's SSH password (Settings → Help → Copyrights and licenses) so your key is installed.
                                    # The installer never asks for or stores a password.
scripts/rm2-fetch-deps              # downloads the two pinned third-party artifacts once and checks their SHA-256
scripts/rm2-install check   --host 10.11.99.1                                   # changes nothing; prints model/version/checks
scripts/rm2-install install --host 10.11.99.1 --url https://<mac-LAN-address>:7779
ssh -t root@10.11.99.1 /home/root/xovi/rebuild_hashtable   # once per software version; asks for the tablet passcode
scripts/rm2-install activate --host 10.11.99.1             # starts it for this boot
```

Then on the tablet: open **AppLoad** (in the sidebar) → **Matrix**. The first-run report appears on the screen with the
detected software version and each check (display, each route, touch). Tap the screen to confirm touch; the session
view follows.

- **Back to the normal reMarkable interface:** tap **Exit** (top right), or drag from the top centre of the screen to
  the middle (AppLoad's close gesture). `scripts/rm2-install stock --host …` turns the whole add-on off now; a **reboot**
  always returns to stock, because activation is a temporary override that does not survive a restart.
- **Uninstall:** `scripts/rm2-install uninstall --host …` removes only the files this installer created (it keeps a
  list on the tablet). Documents, settings and any XOVI/AppLoad setup you already had are not touched.
- **Unsupported software version:** the installer stops before changing anything, prints the exact version and reason
  on the Mac, and writes `matrix-rm2-diagnostic.pdf`. To see that report on the tablet itself, import the PDF with the
  stock USB web interface (`http://10.11.99.1`). That import is a manual step.
- If the Mac's LAN address changes, run `install` again with the new `--url` (the certificate is pinned by name, not by
  address).
- The installer never replaces xochitl, changes firmware or the update policy. A reMarkable software update removes
  nothing of yours but will need `rebuild_hashtable` again, and a version other than 3.28 will be refused until this
  client is updated for it.

What is installed (pinned in `rm2/DEPENDENCIES.json`, checksums enforced, nothing "latest"):

| Piece | Version | License |
|---|---|---|
| XOVI loader + qt-resource-rebuilder | rm-xovi-extensions `pre-v20-08092026` (6c709dd) | LGPL-3.0 / GPL-3.0 |
| AppLoad (display + touch for external apps) | v0.6.0 (7ec0830) | GPL-3.0 |
| Matrix client `matrix-rm2` | this repository, static ARM32 Go binary, no third-party code | — |
| GNU Unifont 16.0.04 (embedded) | pinned checksum | OFL-1.1 / GPL-2.0+ with font exception |

The client is a separate process that talks to AppLoad over its socket; it links none of the GPL code. Mac build tool:
Go (`brew install go`).

## 4. On the road

**This needs one extra piece of equipment that you do not have yet: a small travel router that can run Tailscale**
(for example a GL.iNet model, or any OpenWrt/Linux box). The RM2 cannot run Tailscale itself, and a phone hotspot is not
assumed to pass the phone's VPN to other devices. Nothing was bought or deployed by this build.

Layout: iPhone hotspot (internet) → travel router (uplink to the hotspot, Tailscale on the router) → RM2 on the
router's Wi-Fi. The iPad uses Tailscale directly, as at home.

On the router (addresses are examples; `192.168.8.1` is the router's own LAN address):

```bash
# on the Mac: build the gateway for the router's CPU and copy it over
GOOS=linux GOARCH=arm64 scripts/rm2-build gateway        # prints the binary path; use arm/mipsle/amd64 as needed
# on the router
tailscale up                                             # join your tailnet (do NOT advertise routes or exit node)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj /CN=matrix-gateway.lan -addext subjectAltName=DNS:matrix-gateway.lan -keyout gw-key.pem -out gw-cert.pem
./matrix-rm2-gateway gateway --listen 192.168.8.1:8443 \
  --upstream https://<mac-name>.<tailnet>.ts.net --cert gw-cert.pem --key gw-key.pem
```

The gateway listens only on the router's private LAN address (it refuses `0.0.0.0` and public addresses), forwards only
the five RM2 device routes, and is not a subnet router. Keep the router's own firewall default (no WAN access to 8443).
Copy `gw-cert.pem` to the Mac and add the route to the tablet:

```bash
scripts/rm2-install install --host <tablet address> --url https://<mac-LAN-address>:7779 \
  --travel-url https://192.168.8.1:8443 --travel-cert gw-cert.pem --travel-name matrix-gateway.lan
```

Prove the whole road route before relying on it (tablet on the router's Wi-Fi, router on the hotspot):

```bash
scripts/rm2-preflight --host <tablet address> --endpoint travel-gateway
```

It fetches one authenticated snapshot through tablet → gateway → tailnet → Mac and names the stage if it fails
(`dns`, `connect`, `tls`, `redirect`, `auth`, `upstream`, `protocol`). A working home route never counts for the road
route: each endpoint is reported separately. The RM2 tries the endpoints in order and reconnects by itself; the status
bar names the one in use.

## 5. What the RM2 screen tells you

- Status bar: `LIVE · <route>`; or, inverted: `STALE — last confirmed HH:MM:SS` (no heartbeat for 6 s),
  `DISCONNECTED — … retrying`, `SUSPENDED`, `ERROR: …`, `COLLECTOR ERROR`. Content stays visible but is never shown as
  live when it is not.
- Rows: sessions with Claude evidence first; a row never moves when its state changes. `Prev`/`Next` page the list.
- States: `working`, `NEEDS YOUR INPUT`, `done (turn ended)`, `STUCK` (an error, the pane ended, or
  "No progress observed for 10 minutes"), or `State unavailable` with the reason.
- A field that could not be read says `Unavailable: <reason>`; it is never left blank or guessed.
- Draft strip: what you are typing on the iPad, marked `NOT SENT`. `DELIVERY UNCERTAIN` means the Mac crashed after
  sending and before confirming: it was sent at most once and is never resent automatically.

## 6. Verified on the Mac vs. still to verify on hardware

| Area | Verified by this build (how) | Not verified until you run it |
|---|---|---|
| Rendering, partial/clean refresh rules, touch hit-testing | Host build of the same client code; refresh commands decoded after QTFB encoding; pixel buffers compared | Real panel waveforms, ghosting, how fast "FAST" mode looks, touch calibration |
| ARM client | Cross-compiled static ARM32 binary, reproducible, device display link compiled in | That it runs on the tablet at all |
| AppLoad/XOVI on software 3.28 | Read from upstream source and release history (AppLoad v0.6.0 includes 3.29 support commits) | Actual compatibility with your tablet's exact build; where the version is stored on 3.28 |
| Install / uninstall / rollback | Production installer against a sandbox filesystem with ssh/scp doubles | A real install over SSH; `rebuild_hashtable`; AppLoad listing the app |
| Exit to stock, watchdog | Client exits cleanly on Exit and on SIGTERM; launcher kills a frozen client | That AppLoad closes the window and the stock UI returns; the stock sleep screen on suspend |
| Digest state/prompt/message/question/files | Real hook script + server with synthetic hook events and transcripts (finite test corpus, not a real-world accuracy figure) | Live Claude Code sessions; permission-prompt layouts of your Claude Code version; answering multi-select questions by keys |
| iPad Control typing, selection, answers | Real WebKit browser with real keyboard/mouse events against the real server | iPadOS Safari/Home-Screen behaviour, hardware keyboard shortcuts on iPad |
| Notifications | Outbox, dedupe, retries with a simulated push provider; worker handlers executed | Apple push delivery, the permission prompt, notification tap on iPadOS |
| Home LAN route | Pinned-TLS client against the real server on loopback | The Mac's firewall and your Wi-Fi |
| Road route | Production gateway proxy and preflight on loopback | The travel router, hotspot uplink, Tailscale on the router — untested in the physical topology |

Hardware checklist (in order): `rm2-install check` shows 3.28.x and passes → install → `rebuild_hashtable` → activate →
Matrix appears in AppLoad → first-run screen shows every check `[PASS]` and accepts your tap → rows appear → tap selects
→ typing on the iPad appears on the RM2 within a moment without full-screen flashes → streaming output causes no
repaint → Exit returns to the reMarkable UI → reboot returns to stock → iPad notification arrives and opens the right
session → (with the router) `rm2-preflight --endpoint travel-gateway` passes.

## 7. Tests

```bash
python3 tests/rm2_acceptance.py --candidate . --output /tmp/out/<group>.json --group <group>
# groups: evidence display control push recovery network device security compatibility regression
```

They need Node, Go, tmux, openssl and Playwright's WebKit (`npm i -g playwright && npx playwright install webkit`).
All of them run offline against local doubles; none touches a real tablet, a real push service or your live Matrix.
