package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/session"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// signalContext returns a context cancelled on Ctrl-C, so an attached session
// shuts down cleanly instead of leaving the listener open.
func signalContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)

	go func() {
		select {
		case <-ch:
			cancel()
		case <-ctx.Done():
		}
		signal.Stop(ch)
	}()
	return ctx, cancel
}

type serveOptions struct {
	ListenAddr string
	JoinHost   string
	CodeTTL    time.Duration
	Stdout     io.Writer
	Stderr     io.Writer
	// OnEvent overrides how session events are reported. Nil prints them for a
	// human on Stderr, which is what the serve command wants.
	OnEvent func(sync.Event)
	// OnChange receives structured change events. Nil discards them.
	OnChange func(sync.ChangeEvent)
	// Controls is the supervisor's opaque channel to the peer. Nil disables
	// relaying.
	Controls *session.Control
	// OnReady is called once the listener is bound and the engine is running.
	OnReady func(*session.ServeResult)
	// OnCode overrides how the join code is reported. Nil prints it for a human
	// on Stderr. A machine consumer needs the payload as data rather than as
	// formatted text, which is what the attach mode uses.
	OnCode func(security.JoinCodePayload, string)
}

func serveWorkspace(ctx context.Context, ws *workspace.Workspace, opts serveOptions) (*session.ServeResult, error) {
	onCode := opts.OnCode
	if onCode == nil {
		onCode = joinCodePrinter(opts.Stderr)
	}

	onEvent := opts.OnEvent
	if onEvent == nil {
		onEvent = eventPrinter(opts.Stderr)
	}

	return session.Serve(ctx, ws, session.ServeOptions{
		ListenAddr: opts.ListenAddr,
		JoinHost:   opts.JoinHost,
		CodeTTL:    opts.CodeTTL,
		// Live is what makes this a folder you can edit in: a peer that has
		// joined stays connected, so a change made here reaches it without
		// anyone running a second command.
		Live:     true,
		OnEvent:  onEvent,
		OnChange: opts.OnChange,
		Controls: opts.Controls,
		OnCode:   onCode,
		OnReady:  opts.OnReady,
	})
}

// joinCodePrinter is the human-facing rendering of a join code.
func joinCodePrinter(stderr io.Writer) func(security.JoinCodePayload, string) {
	return func(payload security.JoinCodePayload, formatted string) {
		// The code is printed once, on the host's terminal, for the human to
		// pass to the other peer. Nothing else ever sees it.
		//
		// The expiry comes from the payload rather than from a configured TTL:
		// Serve applies its own default when the caller passes zero, so a
		// caller-facing value would print a time that is already in the past.
		fmt.Fprintf(stderr, "\n")
		fmt.Fprintf(stderr, "Join code (expires %s):\n\n",
			payload.ExpiresAt.Format("15:04:05 UTC"))
		for _, line := range splitLines(formatted) {
			fmt.Fprintf(stderr, "  %s\n", line)
		}
		fmt.Fprintf(stderr, "\nGive the first line to the peer you are inviting. It works once.\n\n")
	}
}

// joinOptions collects everything a joining session needs, so the command layer
// and its tests build the same call.
type joinOptions struct {
	Code    string
	Force   bool
	Policy  workspace.ApplyPolicy
	Stdout  io.Writer
	Stderr  io.Writer
	Live    bool
	OnReady func(*workspace.Workspace, *sync.SyncReport)
	// OnEvent overrides how session events are reported. Nil prints them for a
	// human on Stderr.
	OnEvent func(sync.Event)
	// OnChange receives structured change events. Nil discards them.
	OnChange func(sync.ChangeEvent)
	// Controls is the supervisor's opaque channel to the host. Nil disables
	// relaying.
	Controls *session.Control
}

// joinWorkspace pairs with a host, runs the initial synchronisation, and then
// stays attached. The workspace is returned rather than closed so the caller keeps
// it for the rest of the command.
func joinWorkspace(ctx context.Context, root string, opts joinOptions) (*workspace.Workspace, *sync.SyncReport, error) {
	onEvent := opts.OnEvent
	if onEvent == nil {
		onEvent = eventPrinter(opts.Stderr)
	}
	ws, report, err := session.JoinWithPolicy(ctx, root, session.JoinOptions{
		Code:         opts.Code,
		ForcePairing: opts.Force,
		Live:         opts.Live,
		OnEvent:      onEvent,
		OnChange:     opts.OnChange,
		Controls:     opts.Controls,
		OnReady:      opts.OnReady,
	}, opts.Policy, onEvent)
	if err != nil {
		return nil, nil, err
	}
	// A folder that joined someone else's workspace is a member, never a host.
	if err := ws.SetRole(workspace.RoleMember); err != nil {
		ws.Close()
		return nil, nil, err
	}
	return ws, report, nil
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
