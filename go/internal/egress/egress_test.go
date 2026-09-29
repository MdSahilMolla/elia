package egress

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func TestHostAllowed(t *testing.T) {
	pol := Policy{Allow: []string{"example.com", "*.pypi.org"}}
	cases := map[string]bool{
		"example.com":      true,
		"EXAMPLE.com.":     true,
		"sub.example.com":  false, // exact pattern does not cover subdomains
		"files.pypi.org":   true,
		"pypi.org":         false, // wildcard does not cover the apex
		"evilpypi.org":     false,
		"a.b.pypi.org":     true,
		"example.com.evil": false,
		"":                 false,
	}
	for host, want := range cases {
		if got := pol.HostAllowed(host); got != want {
			t.Errorf("HostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
	if (Policy{}).HostAllowed("example.com") {
		t.Error("an empty allowlist must allow nothing")
	}
}

type collector struct {
	mu     sync.Mutex
	events []Event
}

func (c *collector) sink(e Event) { c.mu.Lock(); c.events = append(c.events, e); c.mu.Unlock() }
func (c *collector) all() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Event(nil), c.events...)
}

func proxyClient(t *testing.T, p *Proxy) (*http.Client, func()) {
	srv := httptest.NewServer(p)
	u, _ := url.Parse(srv.URL)
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(u)}}, srv.Close
}

func TestForwardAllowedAndDenied(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "hello") }))
	defer origin.Close()
	ou, _ := url.Parse(origin.URL)
	host, _, _ := net.SplitHostPort(ou.Host)

	col := &collector{}
	// AllowPrivate so the loopback origin is reachable; the allowlist is what is under test here.
	p := New(Policy{Allow: []string{host}, AllowPrivate: true}, col.sink)
	client, closeProxy := proxyClient(t, p)
	defer closeProxy()

	resp, err := client.Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "hello" {
		t.Fatalf("allowed request: %d %q", resp.StatusCode, body)
	}

	resp, err = client.Get("http://not-allowed.invalid/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("denied request status = %d, want 403", resp.StatusCode)
	}
	ev := col.all()
	if len(ev) != 2 || !ev[0].Allowed || ev[1].Allowed || ev[1].Host != "not-allowed.invalid" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestPrivateAddressRefusedEvenWhenNameAllowed(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "secret") }))
	defer origin.Close()
	ou, _ := url.Parse(origin.URL)
	host, _, _ := net.SplitHostPort(ou.Host)

	col := &collector{}
	p := New(Policy{Allow: []string{host, "localhost"}}, col.sink) // AllowPrivate is off
	client, closeProxy := proxyClient(t, p)
	defer closeProxy()

	resp, err := client.Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a loopback destination", resp.StatusCode)
	}
	ev := col.all()
	if len(ev) != 1 || ev[0].Allowed || !strings.Contains(ev[0].Reason, "private") {
		t.Fatalf("events = %+v", ev)
	}
}

func TestConnectTunnelAndDeny(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	host, portStr, _ := net.SplitHostPort(echo.Addr().String())

	col := &collector{}
	p := New(Policy{Allow: []string{host}, AllowPrivate: true}, col.sink)
	srv := httptest.NewServer(p)
	defer srv.Close()

	connect := func(target string) (*bufio.Reader, net.Conn, string) {
		c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(c, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n")
		r := bufio.NewReader(c)
		status, _ := r.ReadString('\n')
		for {
			line, _ := r.ReadString('\n')
			if line == "\r\n" || line == "" {
				break
			}
		}
		return r, c, status
	}

	r, c, status := connect(net.JoinHostPort(host, portStr))
	if !strings.Contains(status, "200") {
		t.Fatalf("allowed CONNECT status: %q", status)
	}
	io.WriteString(c, "ping\n")
	got, _ := r.ReadString('\n')
	if got != "ping\n" {
		t.Fatalf("echo through tunnel = %q", got)
	}
	c.Close()

	_, c2, status2 := connect("blocked.invalid:443")
	defer c2.Close()
	if !strings.Contains(status2, "403") {
		t.Fatalf("denied CONNECT status: %q", status2)
	}
	allowed, denied := p.Counts()
	if denied != 1 || allowed < 0 {
		t.Fatalf("counts = %d allowed, %d denied", allowed, denied)
	}
}
