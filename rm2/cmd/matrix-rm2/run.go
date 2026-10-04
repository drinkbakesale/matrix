package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"matrixrm2/firstrun"
	"matrixrm2/netc"
	"matrixrm2/ui"
	"matrixrm2/wire"
)

var buildVersion = "dev"

func versionText() string {
	return fmt.Sprintf("matrix-rm2 %s %s/%s protocol %d", buildVersion, runtime.GOOS, runtime.GOARCH, ui.ProtocolVersion)
}

type fileConfig struct {
	netc.Config
	Display struct {
		ui.Config
		RefreshMode *int32 `json:"refresh_mode"`
	} `json:"display"`
}

func loadConfig(path string) (fileConfig, error) {
	var c fileConfig
	c.Display.Config = ui.DefaultConfig()
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("config %s: %w", path, err)
	}
	if err := c.Config.Validate(); err != nil {
		return c, fmt.Errorf("config %s: %w", path, err)
	}
	return c, c.Display.Config.Validate()
}

type ctlLine struct {
	Touch   []int32 `json:"touch"`
	Dump    bool    `json:"dump"`
	Frame   string  `json:"frame"`
	Suspend bool    `json:"suspend"`
	Resume  bool    `json:"resume"`
	Quit    bool    `json:"quit"`
	Fail    int     `json:"fail_panel"`
}

func runMain(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cfgPath := fs.String("config", "/home/root/.config/matrix-rm2/config.json", "client configuration")
	backend := fs.String("backend", "qtfb", "qtfb (device) or capture (host)")
	root := fs.String("root", "/", "filesystem root used for the first-run check")
	xovi := fs.String("xovi", "home/root/xovi", "XOVI directory relative to root")
	stateDir := fs.String("state-dir", "/home/root/.local/share/matrix-rm2", "where the first-run report and markers are kept")
	beatFile := fs.String("heartbeat-file", "", "file touched while the main loop is alive (for the launcher watchdog)")
	touchWait := fs.Int("firstrun-touch-seconds", 120, "how long the first-run screen waits for the confirming tap")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}
	writeReport := func(r firstrun.Report) {
		b, _ := json.MarshalIndent(r, "", " ")
		os.WriteFile(filepath.Join(*stateDir, "firstrun-report.json"), b, 0o600)
	}

	// 1. Fail closed before any display call.
	rep := firstrun.Inspect(*root, *xovi, versionText())
	if !rep.Supported {
		writeReport(rep)
		for _, l := range rep.Text() {
			fmt.Fprintln(os.Stderr, l)
		}
		os.Exit(rep.Code)
	}
	cfg, cfgErr := loadConfig(*cfgPath)

	// 2. Display backend.
	start := time.Now()
	nowMs := func() int64 { return time.Since(start).Milliseconds() }
	var link wire.Link
	var capture *wire.CaptureLink
	switch *backend {
	case "capture":
		capture = wire.NewCaptureLink(nowMs)
		// Host-only fault injection for the capture panel (there is no real panel to break).
		if v, err := strconv.Atoi(os.Getenv("MATRIX_RM2_CAPTURE_FAIL_AT")); err == nil {
			capture.FailAt = v
		}
		link = capture
		// The capture backend replays AppLoad's initialise response so the same
		// compatibility check runs on the host; a fixture can supply another answer.
		resp := wire.EncodeInitResponse(1, int32(ui.ScreenW*ui.ScreenH*2))
		if h := os.Getenv("MATRIX_RM2_CAPTURE_INIT"); h != "" {
			b, err := hex.DecodeString(h)
			if err != nil || len(b) != wire.MsgSize {
				return fmt.Errorf("MATRIX_RM2_CAPTURE_INIT must be %d hex-encoded bytes", wire.MsgSize)
			}
			copy(resp[:], b)
		}
		if _, err := wire.CheckInit(resp); err != nil {
			rep.Supported, rep.Code, rep.Reason = false, firstrun.CodeDisplayFail, "display probe failed: "+err.Error()
			rep.Checks = append(rep.Checks, firstrun.Check{Name: "display probe", OK: false, Detail: err.Error()})
			writeReport(rep)
			fmt.Fprintln(os.Stderr, "fatal: display probe failed:", err)
			os.Exit(firstrun.CodeDisplayFail)
		}
	case "qtfb":
		l, err := wire.DialDevice(wire.SocketPath, os.Getenv("QTFB_KEY"))
		if err != nil {
			rep.Supported, rep.Code, rep.Reason = false, firstrun.CodeDisplayFail, "display probe failed: "+err.Error()
			rep.Checks = append(rep.Checks, firstrun.Check{Name: "display probe", OK: false, Detail: err.Error()})
			writeReport(rep)
			return fmt.Errorf("display probe failed: %w", err)
		}
		link = l
	default:
		return fmt.Errorf("unknown backend %q", *backend)
	}
	// On every exit path the backend is told the client is done, so AppLoad
	// releases the display and input to the stock interface.
	defer func() {
		wire.Release(link)
		if capture != nil {
			json.NewEncoder(os.Stdout).Encode(map[string]any{"released": capture.Released})
		}
	}()
	mode := int32(wire.RefreshFast)
	if cfg.Display.RefreshMode != nil {
		mode = *cfg.Display.RefreshMode
	}
	panel := &wire.Panel{L: link, Mode: mode}

	input := make(chan wire.ServerEvent, 64)
	go func() {
		for {
			m, err := link.Recv()
			if err != nil {
				close(input)
				return
			}
			input <- wire.DecodeServer(m)
		}
	}()
	ctl := make(chan ctlLine, 16)
	enc := json.NewEncoder(os.Stdout)
	if capture != nil {
		go func() {
			sc := bufio.NewScanner(os.Stdin)
			sc.Buffer(make([]byte, 1<<20), 1<<20)
			for sc.Scan() {
				var l ctlLine
				if json.Unmarshal(sc.Bytes(), &l) == nil {
					ctl <- l
				}
			}
		}()
	}

	// 3. First-run screen: the report is shown on the tablet and a tap proves touch.
	marker := filepath.Join(*stateDir, "firstrun-ok-"+rep.Version+"-"+buildVersion)
	if _, err := os.Stat(marker); err != nil {
		rep.Checks = append(rep.Checks, firstrun.Check{Name: "display probe", OK: true, Detail: "QTFB framebuffer 1404x1872 attached"})
		if cfgErr != nil {
			rep.Checks = append(rep.Checks, firstrun.Check{Name: "pairing", OK: false, Detail: cfgErr.Error()})
		} else {
			for _, e := range cfg.Endpoints {
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				stage, err := netc.Probe(ctx, e, cfg.Token)
				cancel()
				detail := "authenticated snapshot received"
				if err != nil {
					detail = stage + ": " + err.Error()
				}
				rep.Checks = append(rep.Checks, firstrun.Check{Name: "route " + e.Name, OK: err == nil, Detail: detail})
			}
		}
		lines := append(rep.Text(), "", "TOUCH CHECK: tap anywhere on the screen to continue.", "(No tap within the time limit closes the client and returns to the reMarkable interface.)")
		if err := panel.Init(ui.TextScreen(lines)); err != nil {
			rep.Supported, rep.Code, rep.Reason = false, firstrun.CodeDisplayFail, "display probe failed: "+err.Error()
			writeReport(rep)
			return fmt.Errorf("display probe failed: %w", err)
		}
		if capture != nil {
			enc.Encode(map[string]any{"firstrun": rep, "screen": lines})
		}
		tapped := false
		deadline := time.After(time.Duration(*touchWait) * time.Second)
	wait:
		for {
			select {
			case ev, ok := <-input:
				if !ok {
					break wait
				}
				if ev.Touch != nil && ev.Touch.Type == "release" {
					tapped = true
					break wait
				}
			case l := <-ctl:
				if l.Quit {
					break wait
				}
				if len(l.Touch) == 4 {
					capture.Inject(wire.EncodeUserInput(l.Touch[0], l.Touch[1], l.Touch[2], l.Touch[3]))
				}
			case <-deadline:
				break wait
			}
		}
		if !tapped {
			rep.Supported, rep.Code, rep.Reason = false, firstrun.CodeTouchFail, "touch probe failed: no tap was received on the first-run screen"
			rep.Checks = append(rep.Checks, firstrun.Check{Name: "touch probe", OK: false, Detail: "no tap received"})
			writeReport(rep)
			return fmt.Errorf("touch probe failed: no tap received")
		}
		rep.Checks = append(rep.Checks, firstrun.Check{Name: "touch probe", OK: true, Detail: "tap received through QTFB"})
		writeReport(rep)
		os.WriteFile(marker, []byte(time.Now().Format(time.RFC3339)), 0o600)
	}
	if cfgErr != nil {
		panel.Init(ui.TextScreen([]string{"Matrix e-ink client cannot start.", "", cfgErr.Error(), "", "Run scripts/rm2-install on the Mac again to pair this tablet.", "This window closes in 30 seconds."}))
		time.Sleep(30 * time.Second)
		return cfgErr
	}

	// 4. Main loop.
	app := ui.NewApp(panel, cfg.Display.Config)
	sync := netc.NewSync(app, func() string { return time.Now().Format("15:04:05") })
	tr := netc.NewTransport(cfg.Config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notices := make(chan string, 8)
	quit := make(chan struct{}, 1)
	app.OnCmd = func(c ui.Command) {
		switch c.Kind {
		case "exit":
			quit <- struct{}{}
		case "select":
			if sync.Status() != "fresh" {
				notices <- "Cannot select: not connected"
				return
			}
			go func() {
				code, body, err := tr.Post(ctx, "/select", map[string]any{"session_id": c.SessionID, "base_revision": c.SelectionRevision})
				switch {
				case err != nil:
					notices <- "Select failed: " + err.Error()
				case code == 409:
					notices <- "Selection changed elsewhere; tap again"
				case code != 200:
					notices <- fmt.Sprintf("Select failed: %v", body["error"])
				default:
					notices <- ""
				}
			}()
		case "view":
			if sync.Status() == "fresh" {
				go tr.Post(ctx, "/view", c.View)
			}
		}
	}
	app.Start(nowMs())
	go tr.Run(ctx)

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGUSR1)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	lastWall := time.Now()
	for {
		var timer <-chan time.Time
		if dl, ok := app.NextDeadline(); ok {
			timer = time.After(time.Duration(max(dl-nowMs(), 0)) * time.Millisecond)
		}
		select {
		case m := <-tr.Out:
			now := nowMs()
			switch m.Kind {
			case "connecting":
				sync.Connecting(m.Endpoint, now)
			case "closed":
				sync.Closed(m.Reason, now)
			case "message":
				resync, err := sync.Message(m.Type, m.Data, now)
				if err != nil {
					fmt.Fprintln(os.Stderr, "sync:", err)
				}
				if resync {
					tr.Resync()
				}
				if m.Type == "view" && sync.Status() == "fresh" {
					var e struct{ View ui.View }
					if json.Unmarshal(m.Data, &e) == nil && app.View() != e.View {
						go tr.Post(ctx, "/view", app.View()) // report the page actually shown after clamping
					}
				}
			}
		case ev, ok := <-input:
			if !ok {
				return fmt.Errorf("display link closed by AppLoad")
			}
			if ev.Touch != nil {
				app.Apply(ui.Event{Kind: "touch", Touch: ev.Touch}, nowMs())
			}
		case n := <-notices:
			app.Apply(ui.Event{Kind: "notice", Notice: n}, nowMs())
		case l := <-ctl:
			switch {
			case l.Quit:
				return nil
			case len(l.Touch) == 4:
				capture.Inject(wire.EncodeUserInput(l.Touch[0], l.Touch[1], l.Touch[2], l.Touch[3]))
			case l.Suspend:
				app.Apply(ui.Event{Kind: "suspend"}, nowMs())
			case l.Resume:
				sync.Closed("resumed from sleep", nowMs())
				app.Apply(ui.Event{Kind: "resume"}, nowMs())
				tr.Resync()
			case l.Fail > 0:
				capture.FailAt = 1
			case l.Frame != "":
				app.RunDue(nowMs(), true)
				if err := writePGM(l.Frame, capture.Mono()); err != nil {
					return err
				}
				enc.Encode(map[string]any{"frame": l.Frame})
			case l.Dump:
				app.RunDue(nowMs(), true)
				enc.Encode(map[string]any{"dump": map[string]any{"visible": app.Visible, "states": app.States(), "conn": app.M.Conn,
					"selection": app.M.Snap.Selection, "notice": app.M.Notice, "full_paints": app.FullPaint, "view": app.View(), "at_ms": nowMs()}})
			}
		case s := <-sig:
			if s == syscall.SIGUSR1 {
				app.Apply(ui.Event{Kind: "suspend"}, nowMs())
			} else {
				return nil
			}
		case <-quit:
			return nil
		case <-tick.C:
			// A jump in wall-clock time means the tablet slept: nothing shown is live until a new snapshot.
			if time.Since(lastWall) > 5*time.Second {
				sync.Closed("resumed from sleep", nowMs())
				app.Apply(ui.Event{Kind: "resume"}, nowMs())
				tr.Resync()
			}
			lastWall = time.Now()
			sync.Tick(nowMs())
			if *beatFile != "" {
				os.WriteFile(*beatFile, []byte(time.Now().Format(time.RFC3339Nano)), 0o600)
			}
		case <-timer:
		}
		app.RunDue(nowMs(), true)
		if app.Fatal != nil {
			return fmt.Errorf("display backend failed: %w", app.Fatal)
		}
		if capture != nil {
			for _, r := range capture.Take() {
				enc.Encode(map[string]any{"refresh": r})
			}
		}
	}
}

func firstrunMain(args []string) int {
	fs := flag.NewFlagSet("firstrun", flag.ContinueOnError)
	root := fs.String("root", "/", "filesystem root to inspect")
	xovi := fs.String("xovi", "home/root/xovi", "XOVI directory relative to root")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	pdf := fs.String("pdf", "", "write a diagnostic PDF built from a report JSON file given with --from")
	from := fs.String("from", "", "report JSON file (with --pdf)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	var rep firstrun.Report
	if *from != "" {
		raw, err := os.ReadFile(*from)
		if err != nil || json.Unmarshal(raw, &rep) != nil {
			fmt.Fprintln(os.Stderr, "firstrun: cannot read report", *from)
			return 2
		}
	} else {
		rep = firstrun.Inspect(*root, *xovi, versionText())
	}
	if *pdf != "" {
		lines := append(rep.Text(), "", "This page was generated on the Mac and imported over USB because",
			"the client could not safely use the tablet's display.")
		if err := firstrun.WritePDF(*pdf, lines); err != nil {
			fmt.Fprintln(os.Stderr, "firstrun:", err)
			return 2
		}
	}
	if *asJSON {
		json.NewEncoder(os.Stdout).Encode(rep)
	} else {
		for _, l := range rep.Text() {
			fmt.Println(l)
		}
	}
	return rep.Code
}
