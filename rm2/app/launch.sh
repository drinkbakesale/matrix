#!/bin/sh
# Launcher for the Matrix e-ink client under AppLoad. It supervises the client:
# if the client exits or stops responding, the window closes and the tablet is
# back on the stock reMarkable interface. A frozen screen that still looks live
# is never left behind.
here="$(cd "$(dirname "$0")" && pwd)"
state="${MATRIX_RM2_STATE:-/home/root/.local/share/matrix-rm2}"
config="${MATRIX_RM2_CONFIG:-/home/root/.config/matrix-rm2/config.json}"
limit="${MATRIX_RM2_WATCHDOG_SECONDS:-20}"
mkdir -p "$state"
beat="$state/heartbeat"
date > "$beat"
"$here/matrix-rm2" run --config "$config" --state-dir "$state" --heartbeat-file "$beat" $MATRIX_RM2_EXTRA_ARGS >> "$state/client.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null' TERM INT
while kill -0 "$pid" 2>/dev/null; do
  sleep 2
  now=$(date +%s)
  mtime=$(stat -c %Y "$beat" 2>/dev/null || stat -f %m "$beat" 2>/dev/null || echo "$now")
  if [ $((now - mtime)) -gt "$limit" ]; then
    echo "$(date) watchdog: client stopped responding for more than ${limit}s; closing it" >> "$state/client.log"
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    exit 70
  fi
done
wait "$pid"
code=$?
echo "$(date) client exited with code $code" >> "$state/client.log"
exit "$code"
