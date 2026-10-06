// Live check of the history-based stream (server/lib/pane-stream.js snapshot + planHistory)
// against a throwaway `claude` in tmux session `streamtest`: replays the server's rules at a
// given poll rate and compares what Matrix would show with what tmux holds.
const { typeInto, snapshot, planHistory } = require('../server/lib/pane-stream');
const T = 'streamtest';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const first = snapshot(T, null);
  let log = first.lines.slice(0, first.historyInCapture);
  let last = first.history; let screen = first.lines.slice(first.historyInCapture);
  const poll = () => {
    const snap = snapshot(T, 2000);
    const add = planHistory(last, snap);
    if (add.resync) { const f = snapshot(T, null); log.push(...f.lines.slice(last, f.historyInCapture)); last = f.history; screen = f.lines.slice(f.historyInCapture); return; }
    log.push(...add.lines); last = snap.history; screen = snap.lines.slice(snap.historyInCapture);
  };
  const timer = setInterval(poll, Number(process.env.POLL || 1000));
  const N = Number(process.env.LINES || 60);
  const tag = 'r' + Date.now().toString(36);
  await typeInto(T, `!for i in $(seq 1 ${N}); do echo ${tag}-line-$i; sleep 0.02; done\r`);
  await sleep(7000); clearInterval(timer); poll();
  const shown = log.concat(screen).join('\n');
  const truth = snapshot(T, null).lines.join('\n');   // what tmux itself holds
  const inTmux = Array.from({ length: N }, (_, i) => tag + '-line-' + (i + 1)).filter(w => new RegExp(w + '\\b').test(truth));
  const missing = inTmux.filter(w => !new RegExp(w + '\\b').test(shown));
  const dup = Array.from({ length: N }, (_, i) => tag + '-line-' + (i + 1)).filter(w => (shown.match(new RegExp(w + '\\b', 'g')) || []).length > 1);
  const junk = log.filter(l => /⏵⏵|Update installed|^─{20,}|^❯/.test(l)).length;
  console.log(`poll ${process.env.POLL || 1000} ms: tmux holds ${inTmux.length} of ${N} lines; Matrix missing ${missing.length}, duplicated ${dup.length}, live-area lines saved into transcript: ${junk}`);
})();
