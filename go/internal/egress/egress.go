// Package egress is the network broker of elia-box: an allowlist forward proxy
// that turns every network attempt a sandboxed command makes into evidence.
//
// The sandbox is what forbids the direct route (Seatbelt permits outbound
// connections only to this proxy's loopback port); the broker decides which
// destinations are reachable through it, refuses to be turned against the local
// network, and records each attempt, allowed or not.
package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Policy says which destinations may be reached.
type Policy struct {
	// Allow lists host patterns: "example.com" matches that host only,
	// "*.example.com" matches any subdomain (not the apex). Empty allows nothing.
	Allow []string
	// AllowPrivate lets the proxy dial loopback/private/link-local addresses.
	// Off by default: a sandboxed command must not reach the host's own services
	// or the cloud metadata endpoint by way of an allowed name that resolves there.
	AllowPrivate bool
}

// Event is one network attempt.
type Event struct {
	Time      time.Time `json:"time"`
	Method    string    `json:"method"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	Allowed   bool      `json:"allowed"`
	Reason    string    `json:"reason,omitempty"`
	BytesUp   int64     `json:"bytesUp"`
	BytesDown int64     `json:"bytesDown"`
}

// Sink receives events as they complete.
type Sink func(Event)

// Proxy is an http.Handler implementing CONNECT tunnels and plain HTTP proxying.
type Proxy struct {
	policy    Policy
	sink      Sink
	dial      func(ctx context.Context, network, addr string) (net.Conn, error)
	transport *http.Transport
	allowed   atomic.Int64
	denied    atomic.Int64
}

// New builds a proxy. sink may be nil.
func New(policy Policy, sink Sink) *Proxy {
	p := &Proxy{policy: policy, sink: sink}
	p.dial = p.checkedDial
	p.transport = &http.Transport{
		Proxy:                 nil,
		DialContext:           p.dial,
		MaxIdleConns:          8,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	return p
}

// Counts returns how many attempts were allowed and denied so far.
func (p *Proxy) Counts() (allowed, denied int64) { return p.allowed.Load(), p.denied.Load() }

func (p *Proxy) emit(e Event) {
	if e.Allowed {
		p.allowed.Add(1)
	} else {
		p.denied.Add(1)
	}
	if p.sink != nil {
		p.sink(e)
	}
}

// HostAllowed reports whether name matches the allowlist.
func (pol Policy) HostAllowed(name string) bool {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	for _, pat := range pol.Allow {
		pat = strings.ToLower(strings.TrimSpace(pat))
		if pat == "" {
			continue
		}
		if strings.HasPrefix(pat, "*.") {
			if strings.HasSuffix(name, pat[1:]) && len(name) > len(pat)-1 {
				return true
			}
			continue
		}
		if pat == name {
			return true
		}
	}
	return false
}

func privateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast()
}

var errPrivate = errors.New("destination resolves to a private or loopback address")

// checkedDial resolves the host itself, refuses private addresses, and dials the
// resolved IP directly, so the address that was checked is the address connected
// to (no second resolution for a rebinding answer to change).
func (p *Proxy) checkedDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, a := range addrs {
			ips = append(ips, a.IP)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no addresses for %s", host)
	}
	if !p.policy.AllowPrivate {
		for _, ip := range ips {
			if privateIP(ip) {
				return nil, errPrivate
			}
		}
	}
	d := net.Dialer{Timeout: 15 * time.Second}
	var last error
	for _, ip := range ips {
		c, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return c, nil
		}
		last = err
	}
	return nil, last
}

func splitTarget(hostport string, defPort int) (string, int) {
	host, portStr, err := net.SplitHostPort(hostport)
	if err != nil {
		return strings.Trim(hostport, "[]"), defPort
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		port = defPort
	}
	return host, port
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	p.forward(w, r)
}

func (p *Proxy) deny(w http.ResponseWriter, ev Event, status int, reason string) {
	ev.Allowed, ev.Reason = false, reason
	p.emit(ev)
	http.Error(w, "elia-box egress: "+reason, status)
}

func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	host, port := splitTarget(r.Host, 443)
	ev := Event{Time: time.Now().UTC(), Method: "CONNECT", Host: host, Port: port}
	if !p.policy.HostAllowed(host) {
		p.deny(w, ev, http.StatusForbidden, "host not on the allowlist")
		return
	}
	upstream, err := p.dial(r.Context(), "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		reason := "dial failed: " + err.Error()
		if errors.Is(err, errPrivate) {
			reason = errPrivate.Error()
		}
		p.deny(w, ev, http.StatusBadGateway, reason)
		return
	}
	defer upstream.Close()
	hj, ok := w.(http.Hijacker)
	if !ok {
		p.deny(w, ev, http.StatusInternalServerError, "connection cannot be hijacked")
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		p.deny(w, ev, http.StatusInternalServerError, "hijack failed")
		return
	}
	defer client.Close()
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	var up, down int64
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		up, _ = io.Copy(upstream, client)
		if tc, ok := upstream.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		down, _ = io.Copy(client, upstream)
		if tc, ok := client.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	wg.Wait()
	ev.Allowed, ev.BytesUp, ev.BytesDown = true, up, down
	p.emit(ev)
}

var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

func (p *Proxy) forward(w http.ResponseWriter, r *http.Request) {
	if !r.URL.IsAbs() {
		http.Error(w, "elia-box egress: this is a forward proxy; send an absolute URL", http.StatusBadRequest)
		return
	}
	defPort := 80
	if r.URL.Scheme == "https" {
		defPort = 443
	}
	host, port := splitTarget(r.URL.Host, defPort)
	ev := Event{Time: time.Now().UTC(), Method: r.Method, Host: host, Port: port}
	if r.URL.Scheme != "http" {
		p.deny(w, ev, http.StatusBadRequest, "only http may be forwarded; use CONNECT for tls")
		return
	}
	if !p.policy.HostAllowed(host) {
		p.deny(w, ev, http.StatusForbidden, "host not on the allowlist")
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	resp, err := p.transport.RoundTrip(out)
	if err != nil {
		reason := "upstream failed: " + err.Error()
		if errors.Is(err, errPrivate) {
			reason = errPrivate.Error()
		}
		p.deny(w, ev, http.StatusBadGateway, reason)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	n, _ := io.Copy(w, resp.Body)
	ev.Allowed, ev.BytesDown = true, n
	if r.ContentLength > 0 {
		ev.BytesUp = r.ContentLength
	}
	p.emit(ev)
}

// JSONLSink returns a Sink writing one JSON object per line to w.
func JSONLSink(w io.Writer) Sink {
	var mu sync.Mutex
	enc := json.NewEncoder(w)
	return func(e Event) {
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(e)
	}
}
