package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
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
//
// With --public it may instead run on an internet server that is on the
// tailnet, for a tablet with no router. That is an explicit choice: it still
// names one address, and it then requires --token-sha256, so a request that
// does not carry the one paired device token is answered here and never
// reaches the Mac.
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
	public := fs.Bool("public", false, "allow --listen to be a public address (internet server on the tailnet); requires --token-sha256")
	tokenSHA := fs.String("token-sha256", "", "hex SHA-256 of the one device token to forward; any other request is answered 401 here")
	if err := fs.Parse(args); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return fmt.Errorf("--listen must be address:port: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsUnspecified() {
		return errors.New("--listen must name one address (not 0.0.0.0 or ::): the gateway must not listen on every interface")
	}
	private := ip.IsPrivate() || ip.IsLoopback()
	if !private && !*public {
		return fmt.Errorf("--listen %s is not a private address; refusing to expose Matrix on a public interface (an internet server needs --public and --token-sha256)", host)
	}
	var wantToken []byte
	if *tokenSHA != "" {
		wantToken, err = hex.DecodeString(*tokenSHA)
		if err != nil || len(wantToken) != sha256.Size {
			return errors.New("--token-sha256 must be the 64 hex characters printed by rm2-install")
		}
	}
	if !private && wantToken == nil {
		return errors.New("--public needs --token-sha256: a gateway on a public address forwards only the paired tablet's token")
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
		if wantToken != nil {
			got := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
			if subtle.ConstantTimeCompare(got[:], wantToken) != 1 {
				http.Error(w, `{"error":"this gateway forwards only its paired tablet"}`, http.StatusUnauthorized)
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10) // device commands are a few hundred bytes
		proxy.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	scope := "device API only"
	if wantToken != nil {
		scope += ", paired tablet only"
	}
	if !private {
		scope += ", PUBLIC address"
	}
	fmt.Fprintf(os.Stderr, "gateway: listening on https://%s -> %s (%s)\n", *listen, up.Host, scope)
	return srv.ListenAndServeTLS(*cert, *key)
}
