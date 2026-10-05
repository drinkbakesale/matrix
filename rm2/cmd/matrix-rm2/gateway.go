package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// The travel gateway runs on a small Tailscale-capable Linux/OpenWrt router.
// It listens with TLS on the gateway's private downstream address only and
// forwards nothing but the RM2 device API to Matrix over the tailnet. It is
// not a subnet router and exposes no other Matrix route.
var gatewayRoutes = map[string]bool{
	"GET /api/eink/v1/snapshot":    true,
	"GET /api/eink/v1/events":      true,
	"GET /api/eink/v1/push/health": true,
	"POST /api/eink/v1/select":     true,
	"POST /api/eink/v1/view":       true,
}

func gatewayMain(args []string) error {
	fs := flag.NewFlagSet("gateway", flag.ContinueOnError)
	listen := fs.String("listen", "", "private downstream address:port to listen on, e.g. 192.168.8.1:8443")
	upstream := fs.String("upstream", "", "Matrix over the tailnet, e.g. https://mac.tailnet-name.ts.net")
	cert := fs.String("cert", "", "TLS certificate (PEM) the RM2 pins")
	key := fs.String("key", "", "TLS private key (PEM)")
	upCA := fs.String("upstream-ca", "", "PEM file with the only certificate trusted for the upstream (default: system trust store, as used by Tailscale Serve)")
	upName := fs.String("upstream-name", "", "name the upstream certificate was issued for, when it differs from the host in --upstream")
	if err := fs.Parse(args); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return fmt.Errorf("--listen must be address:port: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsUnspecified() {
		return errors.New("--listen must name one private address (not 0.0.0.0 or ::): the gateway must not listen on its uplink")
	}
	if !(ip.IsPrivate() || ip.IsLoopback()) {
		return fmt.Errorf("--listen %s is not a private address; refusing to expose Matrix on a public interface", host)
	}
	up, err := url.Parse(*upstream)
	if err != nil || up.Scheme != "https" || up.Host == "" {
		return errors.New("--upstream must be an https:// tailnet address")
	}
	upTLS := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: *upName}
	if *upCA != "" {
		pem, err := os.ReadFile(*upCA)
		if err != nil {
			return fmt.Errorf("--upstream-ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return errors.New("--upstream-ca is not a PEM certificate")
		}
		upTLS.RootCAs = pool
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(up)
			r.Out.Host = up.Host
		},
		FlushInterval: -1, // server-sent events must not be buffered
		Transport:     &http.Transport{TLSClientConfig: upTLS, ResponseHeaderTimeout: 15 * time.Second},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			fmt.Fprintln(os.Stderr, "gateway: upstream:", err)
			http.Error(w, `{"error":"gateway cannot reach Matrix over the tailnet"}`, http.StatusBadGateway)
		},
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !gatewayRoutes[r.Method+" "+strings.TrimRight(r.URL.Path, "/")] || r.URL.RawQuery != "" {
			http.Error(w, `{"error":"this gateway forwards only the RM2 device API"}`, http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	fmt.Fprintf(os.Stderr, "gateway: listening on https://%s -> %s (device API only)\n", *listen, up.Host)
	return srv.ListenAndServeTLS(*cert, *key)
}
