package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"matrixrm2/netc"
)

// probeMain is the whole-route preflight: for each configured endpoint (or
// the one named with --endpoint) it fetches an authenticated snapshot and
// reports the stage that failed. One route passing never hides another failing.
func probeMain(args []string) int {
	fs := flag.NewFlagSet("probe", flag.ContinueOnError)
	cfgPath := fs.String("config", "/home/root/.config/matrix-rm2/config.json", "client configuration")
	only := fs.String("endpoint", "", "probe only this endpoint name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		return 2
	}
	type result struct {
		Endpoint string `json:"endpoint"`
		OK       bool   `json:"ok"`
		Stage    string `json:"stage"`
		Reason   string `json:"reason"`
	}
	var results []result
	failed, matched := false, false
	for _, e := range cfg.Endpoints {
		if *only != "" && e.Name != *only {
			continue
		}
		matched = true
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		stage, err := netc.Probe(ctx, e, cfg.Token)
		cancel()
		r := result{Endpoint: e.Name, OK: err == nil, Stage: stage}
		if err != nil {
			r.Reason = err.Error()
			failed = true
		}
		results = append(results, r)
	}
	if !matched {
		fmt.Fprintf(os.Stderr, "probe: no endpoint named %q in the configuration\n", *only)
		return 2
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"results": results})
	if failed {
		return 1
	}
	return 0
}
