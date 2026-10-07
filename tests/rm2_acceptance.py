#!/usr/bin/env python3
"""Acceptance runner for the RM2 e-ink workstation.

Usage: rm2_acceptance.py --candidate DIR --output FILE --group GROUP

Runs the behavioural cases of one group (tests/rm2/groups/<group>.js) against
production code and writes {"assertions":[{"id","status","detail"}]}. Every
expected test id is always reported; a case that cannot run is a failure,
never a skip. Detailed logs and traces are stored beside the output file.
"""
import argparse, json, pathlib, shutil, subprocess, sys

EXPECTED = {
    "evidence": ["full_turn", "questions_permissions", "identity_isolation", "corruption_unknown", "stuck_rules", "files_provenance", "replay_order"],
    "display": ["pixels_and_modes", "real_touch", "pagination", "quiet_boundaries", "lifecycle"],
    "control": ["bidirectional_selection", "keyboard_mouse_ime", "literal_submit", "selection_race", "pending_answer", "quick_access"],
    "push": ["all_transitions", "durable_dedup", "failure_health", "click_routing"],
    "recovery": ["stale_and_reconnect", "epoch_gap", "draft_persistence", "uncertain_delivery", "session_survival"],
    "network": ["public_gateway", "silent_route_failover", "endpoint_failover", "route_preflight", "private_transport"],
    "device": ["arm_package", "firmware_preflight", "install_restore", "rollback_failures", "unsupported_report"],
    "security": ["capabilities", "identity_and_paths", "injection_and_secrets", "persistence_failure"],
    "compatibility": ["old_views", "worker_isolation"],
    "regression": ["base_red_candidate_green"],
}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--candidate", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--group", required=True, choices=sorted(EXPECTED))
    a = p.parse_args()
    out = pathlib.Path(a.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    logs = out.parent / (out.stem + "-artifacts")
    logs.mkdir(parents=True, exist_ok=True)
    ids = [f"RM2_{a.group}::{name}" for name in EXPECTED[a.group]]
    raw = logs / "node-result.json"
    if raw.exists():
        raw.unlink()
    node = shutil.which("node")
    results = None
    detail = ""
    if node is None:
        detail = "node is not on PATH"
    else:
        cmd = [node, str(pathlib.Path(a.candidate).resolve() / "tests" / "rm2" / "run.js"),
               "--group", a.group, "--candidate", str(pathlib.Path(a.candidate).resolve()), "--artifacts", str(logs), "--result", str(raw)]
        try:
            run = subprocess.run(cmd, cwd=a.candidate, capture_output=True, text=True, timeout=570)
            (logs / "runner.log").write_text(run.stdout + "\n--- stderr ---\n" + run.stderr)
            if raw.exists():
                results = {r["id"]: r for r in json.loads(raw.read_text())["assertions"]}
            else:
                detail = f"runner produced no result (exit {run.returncode}): {run.stderr[-400:]}"
        except subprocess.TimeoutExpired:
            detail = "runner timed out after 570s"
    assertions = []
    for i in ids:
        r = (results or {}).get(i)
        if r and r.get("status") in ("passed", "failed"):
            assertions.append({"id": i, "status": r["status"], "detail": str(r.get("detail", ""))[:1500]})
        else:
            assertions.append({"id": i, "status": "failed", "detail": detail or "the runner did not report this test"})
    out.write_text(json.dumps({"assertions": assertions}, indent=1))
    sys.exit(0 if all(x["status"] == "passed" for x in assertions) else 1)

if __name__ == "__main__":
    main()
