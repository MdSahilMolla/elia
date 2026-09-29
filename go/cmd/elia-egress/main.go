// elia-egress runs the elia-box network broker.
//
//	elia-egress --allow pypi.org,*.pythonhosted.org --log egress.jsonl
//
// It listens on loopback, prints {"listening":"127.0.0.1:PORT"} as its first
// stdout line, and stops cleanly on SIGINT or SIGTERM.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"elia-go/internal/egress"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "loopback address to listen on")
	allow := flag.String("allow", "", "comma-separated host patterns (example.com, *.example.com)")
	logPath := flag.String("log", "", "file receiving one JSON event per line (default: stderr)")
	allowPrivate := flag.Bool("allow-private", false, "permit dialing loopback/private addresses (tests only)")
	flag.Parse()

	host, _, err := net.SplitHostPort(*listen)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		fmt.Fprintln(os.Stderr, "elia-egress: --listen must be a loopback ip:port")
		os.Exit(2)
	}
	logOut := os.Stderr
	if *logPath != "" {
		f, err := os.OpenFile(*logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			fmt.Fprintln(os.Stderr, "elia-egress:", err)
			os.Exit(2)
		}
		defer f.Close()
		logOut = f
	}
	var patterns []string
	for _, p := range strings.Split(*allow, ",") {
		if p = strings.TrimSpace(p); p != "" {
			patterns = append(patterns, p)
		}
	}
	proxy := egress.New(egress.Policy{Allow: patterns, AllowPrivate: *allowPrivate}, egress.JSONLSink(logOut))

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "elia-egress:", err)
		os.Exit(1)
	}
	line, _ := json.Marshal(map[string]string{"listening": ln.Addr().String()})
	fmt.Println(string(line))

	srv := &http.Server{Handler: proxy, ReadHeaderTimeout: 15 * time.Second}
	done := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		close(done)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "elia-egress:", err)
		os.Exit(1)
	}
	<-done
}
