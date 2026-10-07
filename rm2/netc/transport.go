package netc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const apiBase = "/api/eink/v1"

const connectTimeout = 8 * time.Second

// Endpoint is one private route to Matrix. The digest protocol does not care
// which one is in use; the list is tried in order with backoff.
type Endpoint struct {
	Name string `json:"name"`
	URL  string `json:"url"` // https://host:port
	// CertPEM pins the server: it is the only trusted root for this endpoint.
	// Empty means the system trust store (for a tailnet HTTPS name).
	CertPEM string `json:"cert_pem"`
	// ServerName is the name the certificate was issued for, when it differs
	// from the host in URL (a LAN address that may change).
	ServerName string `json:"server_name"`
	// PinSHA256 is the hex SHA-256 of the server certificate (DER). Required with CertPEM.
	PinSHA256 string `json:"pin_sha256"`
}

type Config struct {
	Endpoints []Endpoint `json:"endpoints"`
	Token     string     `json:"token"`
}

func (c Config) Validate() error {
	if len(c.Endpoints) == 0 {
		return errors.New("config has no endpoints")
	}
	if len(c.Token) < 20 {
		return errors.New("config has no device token")
	}
	for _, e := range c.Endpoints {
		u, err := url.Parse(e.URL)
		if err != nil || u.Host == "" {
			return fmt.Errorf("endpoint %q: invalid url", e.Name)
		}
		if u.Scheme != "https" {
			return fmt.Errorf("endpoint %q: only https is allowed (got %q); plaintext is refused", e.Name, u.Scheme)
		}
		if u.User != nil || u.RawQuery != "" {
			return fmt.Errorf("endpoint %q: credentials or query strings are not allowed in the url", e.Name)
		}
		if e.CertPEM != "" && len(e.PinSHA256) != 64 {
			return fmt.Errorf("endpoint %q: a pinned certificate needs pin_sha256", e.Name)
		}
	}
	return nil
}

func tlsConfig(e Endpoint) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: e.ServerName}
	if e.CertPEM == "" {
		return cfg, nil // system roots, normal hostname verification
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(e.CertPEM)) {
		return nil, fmt.Errorf("endpoint %q: cert_pem is not a certificate", e.Name)
	}
	cfg.RootCAs = pool
	want := strings.ToLower(e.PinSHA256)
	// Standard chain and name verification still runs; this adds the exact-certificate pin.
	cfg.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
		if len(raw) == 0 {
			return errors.New("server sent no certificate")
		}
		sum := sha256.Sum256(raw[0])
		if hex.EncodeToString(sum[:]) != want {
			return errors.New("server certificate does not match the pinned certificate")
		}
		return nil
	}
	return cfg, nil
}

func client(e Endpoint, timeout time.Duration) (*http.Client, error) {
	tc, err := tlsConfig(e)
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout:   timeout,
		// Away from home the LAN address goes nowhere and no refusal comes back: without a
		// connect timeout the operating system's own (minutes) would hold up the next route.
		Transport: &http.Transport{TLSClientConfig: tc, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 10 * time.Second, Proxy: nil,
			DialContext: (&net.Dialer{Timeout: connectTimeout}).DialContext, TLSHandshakeTimeout: connectTimeout},
		// A redirect could send the token to another host or to plaintext: never follow.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

// Message is one SSE message or a transport state change.
type Message struct {
	Kind     string // connecting open message closed
	Endpoint string
	Type     string
	Data     []byte
	Reason   string
}

// Transport streams events from the first endpoint that works, rotating with
// bounded exponential backoff (1..30s plus jitter).
type Transport struct {
	Cfg     Config
	Out     chan Message
	resync  chan struct{}
	current int
}

func NewTransport(cfg Config) *Transport {
	return &Transport{Cfg: cfg, Out: make(chan Message, 64), resync: make(chan struct{}, 1)}
}

// Resync drops the current stream so a fresh snapshot is fetched.
func (t *Transport) Resync() {
	select {
	case t.resync <- struct{}{}:
	default:
	}
}

func (t *Transport) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		e := t.Cfg.Endpoints[t.current%len(t.Cfg.Endpoints)]
		t.Out <- Message{Kind: "connecting", Endpoint: e.Name}
		got, err := t.stream(ctx, e)
		if ctx.Err() != nil {
			return
		}
		reason := "stream ended"
		if err != nil {
			reason = err.Error()
		}
		t.Out <- Message{Kind: "closed", Endpoint: e.Name, Reason: reason}
		if got {
			backoff = time.Second // it worked for a while: retry the same endpoint promptly
		} else {
			t.current++ // rotate to the next configured route
		}
		wait := backoff + time.Duration(rand.Int63n(int64(backoff/10)+1))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if !got && backoff < 30*time.Second {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (t *Transport) stream(ctx context.Context, e Endpoint) (got bool, err error) {
	c, err := client(e, 0)
	if err != nil {
		return false, err
	}
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-t.resync:
			cancel()
		case <-sctx.Done():
		}
	}()
	req, _ := http.NewRequestWithContext(sctx, "GET", strings.TrimRight(e.URL, "/")+apiBase+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+t.Cfg.Token)
	req.Header.Set("Accept", "text/event-stream")
	res, err := c.Do(req)
	if err != nil {
		return false, redact(err, t.Cfg.Token)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return false, fmt.Errorf("%s answered HTTP %d (%s)", e.Name, res.StatusCode, statusHint(res.StatusCode))
	}
	t.Out <- Message{Kind: "open", Endpoint: e.Name}
	rd := bufio.NewReaderSize(res.Body, 1<<20)
	var typ string
	var data bytes.Buffer
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			if sctx.Err() != nil && ctx.Err() == nil {
				return got, errors.New("resync requested")
			}
			return got, redact(err, t.Cfg.Token)
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if typ != "" {
				got = true
				t.Out <- Message{Kind: "message", Endpoint: e.Name, Type: typ, Data: append([]byte(nil), data.Bytes()...)}
			}
			typ = ""
			data.Reset()
		case strings.HasPrefix(line, "event: "):
			typ = line[7:]
		case strings.HasPrefix(line, "data: "):
			data.WriteString(line[6:])
		}
	}
}

func statusHint(code int) string {
	switch code {
	case 401:
		return "device token unknown, expired or revoked: pair again"
	case 403:
		return "this token is not a device token"
	case 503:
		return "Matrix e-ink service did not start; check the Mac"
	}
	return http.StatusText(code)
}

func redact(err error, token string) error {
	if token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), token, "[token]"))
}

// Post sends one command to the endpoint currently in use.
func (t *Transport) Post(ctx context.Context, path string, body any) (int, map[string]any, error) {
	e := t.Cfg.Endpoints[t.current%len(t.Cfg.Endpoints)]
	c, err := client(e, 8*time.Second)
	if err != nil {
		return 0, nil, err
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(e.URL, "/")+apiBase+path, bytes.NewReader(buf))
	req.Header.Set("Authorization", "Bearer "+t.Cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return 0, nil, redact(err, t.Cfg.Token)
	}
	defer res.Body.Close()
	out := map[string]any{}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	json.Unmarshal(raw, &out)
	return res.StatusCode, out, nil
}

// Probe fetches one authenticated snapshot through e. It is the whole-route
// check used by preflight: success proves DNS, TLS, pin, token and upstream.
func Probe(ctx context.Context, e Endpoint, token string) (stage string, err error) {
	u, perr := url.Parse(e.URL)
	if perr != nil || u.Scheme != "https" {
		return "config", fmt.Errorf("endpoint %q is not an https url", e.Name)
	}
	c, err := client(e, 10*time.Second)
	if err != nil {
		return "config", err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(e.URL, "/")+apiBase+"/snapshot", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.Do(req)
	if err != nil {
		msg := redact(err, token).Error()
		switch {
		case strings.Contains(msg, "no such host") || strings.Contains(msg, "lookup"):
			return "dns", errors.New(msg)
		case strings.Contains(msg, "certificate") || strings.Contains(msg, "tls:") || strings.Contains(msg, "x509"):
			return "tls", errors.New(msg)
		default:
			return "connect", errors.New(msg)
		}
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<22))
	switch {
	case res.StatusCode >= 300 && res.StatusCode < 400:
		return "redirect", fmt.Errorf("endpoint answered with a redirect (HTTP %d); redirects are refused", res.StatusCode)
	case res.StatusCode == 401 || res.StatusCode == 403:
		return "auth", fmt.Errorf("HTTP %d: %s", res.StatusCode, statusHint(res.StatusCode))
	case res.StatusCode == 502 || res.StatusCode == 503 || res.StatusCode == 504:
		return "upstream", fmt.Errorf("HTTP %d: the gateway is reachable but Matrix behind it is not", res.StatusCode)
	case res.StatusCode != 200:
		return "upstream", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var snap struct {
		Protocol int    `json:"protocol"`
		Epoch    string `json:"epoch"`
	}
	if json.Unmarshal(body, &snap) != nil || snap.Epoch == "" {
		return "upstream", errors.New("the answer is not a Matrix snapshot")
	}
	if snap.Protocol != 1 {
		return "protocol", fmt.Errorf("Matrix speaks protocol %d; this client understands 1", snap.Protocol)
	}
	return "ok", nil
}
