// matrix-rm2 is the Matrix e-ink client for the reMarkable 2. The same binary
// is built for the device (linux/arm) and for the host (capture backend).
package main

import (
	"fmt"
	"os"

	"matrixrm2/font"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage: matrix-rm2 <command>
  run       connect to Matrix and drive the display (device: QTFB, host: --backend capture)
  firstrun  check device model, software version and display/touch backend; prints a report
  gateway   travel gateway: TLS proxy that forwards only the device API to Matrix over the tailnet (private address, or --public)
  probe     whole-route preflight for each configured endpoint
  script    host capture: drive the production renderer from a JSON script on stdin
  version   print build information`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	if err := font.Check(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
	var err error
	switch os.Args[1] {
	case "script":
		err = scriptMain(os.Stdin, os.Stdout)
	case "run":
		err = runMain(os.Args[2:])
	case "firstrun":
		os.Exit(firstrunMain(os.Args[2:]))
	case "gateway":
		err = gatewayMain(os.Args[2:])
	case "probe":
		os.Exit(probeMain(os.Args[2:]))
	case "version":
		fmt.Println(versionText())
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}
