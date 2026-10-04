#!/bin/sh
# device.sh — runs ON the reMarkable 2 (over SSH) to install, check or remove
# the Matrix e-ink client. It never replaces xochitl, changes firmware or the
# update policy, or touches documents. It records exactly what it created and
# removes only that. RM2_ROOT prefixes every path (empty on the real device).
set -u
ROOT="${RM2_ROOT:-}"
STAGE="$ROOT/tmp/matrix-rm2"
XOVI="$ROOT/home/root/xovi"
APP="$XOVI/exthome/appload/matrix-rm2"
CONF_DIR="$ROOT/home/root/.config/matrix-rm2"
STATE="$ROOT/home/root/.local/share/matrix-rm2"
OWNED="$STATE/owned.txt"
RUNLOG="$STATE/install-run.txt"
XOVI_START="${RM2_XOVI_START:-$XOVI/start}"
XOVI_STOCK="${RM2_XOVI_STOCK:-$XOVI/stock}"

say() { echo "device: $*"; }
fail() { echo "device: ERROR: $*" >&2; rollback; exit 1; }

own() { # record a path this installer created (once)
  mkdir -p "$STATE"
  grep -qxF "$1" "$OWNED" 2>/dev/null || echo "$1" >> "$OWNED"
  echo "$1" >> "$RUNLOG"
}

rollback() { # undo only what THIS run created
  if [ -f "$RUNLOG" ]; then
    say "rolling back this run"
    tac_file "$RUNLOG" | while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ -d "$ROOT$p" ] && [ ! -L "$ROOT$p" ]; then rmdir "$ROOT$p" 2>/dev/null || true; else rm -f "$ROOT$p"; fi
      if [ -f "$OWNED" ]; then grep -vxF "$p" "$OWNED" > "$OWNED.tmp" 2>/dev/null; mv "$OWNED.tmp" "$OWNED"; fi
    done
    rm -f "$RUNLOG"
  fi
  [ -s "$OWNED" ] || rm -f "$OWNED"
  rmdir "$STATE" 2>/dev/null || true # leaves it only if an earlier install still owns files
}

tac_file() { awk '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) print l[i] }' "$1"; }

sha() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }

verify_stage() { # every staged file must match the manifest sent with it
  [ -f "$STAGE/SHA256SUMS" ] || fail "stage manifest missing (transfer incomplete)"
  while read -r want rel; do
    [ -f "$STAGE/$rel" ] || fail "staged file missing: $rel (transfer incomplete)"
    got=$(sha "$STAGE/$rel")
    [ "$got" = "$want" ] || fail "checksum mismatch for $rel (transfer corrupted): expected $want got $got"
  done < "$STAGE/SHA256SUMS"
}

place() { # place <staged rel> <absolute device path> <mode>: never overwrites a file we do not own
  src="$STAGE/$1"; dst="$2"; mode="$3"
  dir=$(dirname "$dst")
  mkdirs "$dir"
  if [ -e "$ROOT$dst" ] && ! grep -qxF "$dst" "$OWNED" 2>/dev/null; then
    if [ "$(sha "$ROOT$dst")" = "$(sha "$src")" ]; then return 0; fi
    fail "dependency incompatibility: $dst already exists with different contents and was not installed by Matrix; it was left untouched"
  fi
  cp "$src" "$ROOT$dst.matrix-new" || fail "cannot write $dst"
  chmod "$mode" "$ROOT$dst.matrix-new"
  mv "$ROOT$dst.matrix-new" "$ROOT$dst" || fail "cannot place $dst"
  own "$dst"
}

mkdirs() { # create missing directories one level at a time, recording each
  d="$1"; todo=""
  while [ ! -d "$ROOT$d" ] && [ "$d" != "/" ] && [ -n "$d" ]; do todo="$d
$todo"; d=$(dirname "$d"); done
  echo "$todo" | while IFS= read -r n; do [ -n "$n" ] || continue; mkdir "$ROOT$n" || exit 1; own "$n"; done
}

cmd_check() { # first-run check with the staged client; prints the JSON report
  "$STAGE/matrix-rm2" firstrun --root "${ROOT:-/}" --json
}

cmd_install() {
  rm -f "$RUNLOG"
  verify_stage
  mkdir -p "$STATE"
  # Display stack. A XOVI installation that Matrix did not install is used as it
  # is: none of its files are replaced. Otherwise the pinned bundle is installed.
  if [ -e "$XOVI/xovi.so" ] && ! grep -qxF "/home/root/xovi/xovi.so" "$OWNED" 2>/dev/null; then
    say "using the existing XOVI installation; its files are not modified"
  else
    (cd "$STAGE/xovi" && find . -type f | sed 's|^\./||') | while IFS= read -r rel; do
      case "$rel" in inactive-extensions/*|debug|scripts/debug/*) continue ;; esac
      mode=644; case "$rel" in start|stock|rebuild_hashtable|*.so) mode=755 ;; esac
      place "xovi/$rel" "/home/root/xovi/$rel" "$mode" || exit 1
    done || exit 1
    for d in scripts/pre-start scripts/post-start scripts/pre-stock scripts/post-stock exthome/qt-resource-rebuilder; do mkdirs "/home/root/xovi/$d"; done
  fi
  place "appload.so" "/home/root/xovi/extensions.d/appload.so" 755
  place "app/matrix-rm2" "/home/root/xovi/exthome/appload/matrix-rm2/matrix-rm2" 755
  place "app/launch.sh" "/home/root/xovi/exthome/appload/matrix-rm2/launch.sh" 755
  place "app/external.manifest.json" "/home/root/xovi/exthome/appload/matrix-rm2/external.manifest.json" 644
  place "app/icon.png" "/home/root/xovi/exthome/appload/matrix-rm2/icon.png" 644
  place "config.json" "/home/root/.config/matrix-rm2/config.json" 600
  rm -f "$RUNLOG"
  rm -rf "$STAGE"
  say "installed"
}

cmd_activate() { # start XOVI for this boot (tmpfs override: a reboot returns to stock)
  [ -x "$XOVI_START" ] || fail "xovi start script missing"
  "$XOVI_START" || { "$XOVI_STOCK" 2>/dev/null; fail "starting XOVI failed; the stock interface was restored"; }
  say "XOVI started: open AppLoad on the tablet and choose Matrix. Reboot or run 'stock' to return to the stock interface."
}

cmd_stock() {
  [ -x "$XOVI_STOCK" ] || { say "xovi is not installed; the tablet is already stock"; return 0; }
  "$XOVI_STOCK" || { echo "device: ERROR: restoring stock failed; reboot the tablet to return to stock" >&2; exit 1; }
  say "stock interface restored"
}

cmd_uninstall() {
  if [ ! -f "$OWNED" ]; then say "nothing installed by Matrix; nothing changed"; return 0; fi
  # If we installed XOVI itself, make sure the stock interface is running before removing it.
  if grep -qxF "/home/root/xovi/xovi.so" "$OWNED" && [ -x "$XOVI_STOCK" ]; then "$XOVI_STOCK" || { echo "device: ERROR: could not return to stock; nothing was removed. Reboot and run uninstall again." >&2; exit 1; }; fi
  tac_file "$OWNED" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -d "$ROOT$p" ] && [ ! -L "$ROOT$p" ]; then rmdir "$ROOT$p" 2>/dev/null || true; else rm -f "$ROOT$p"; fi
  done
  rm -f "$OWNED" "$RUNLOG" "$STATE/heartbeat" "$STATE/client.log" "$STATE/firstrun-report.json" "$STATE"/firstrun-ok-*
  rmdir "$STATE" 2>/dev/null || true
  say "uninstalled: removed only what Matrix installed"
}

case "${1:-}" in
  check) cmd_check ;;
  install) cmd_install ;;
  activate) cmd_activate ;;
  stock) cmd_stock ;;
  uninstall) cmd_uninstall ;;
  *) echo "usage: device.sh check|install|activate|stock|uninstall" >&2; exit 2 ;;
esac
