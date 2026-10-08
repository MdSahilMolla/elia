package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/session"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// newAttachCommand runs a workspace as a long-lived process that reports file
// changes as newline-delimited JSON on stdout.
//
// It is the interface a supervisor such as Elia uses. The ordinary `serve` and
// `join` commands print for a human and own their terminal; this one writes
// frames to stdout and nothing else, so a consumer can parse the stream without
// filtering prose out of it.
func newAttachCommand(stdin io.Reader, stdout, stderr io.Writer) *cobra.Command {
	var (
		serve     bool
		joinCode  string
		listen    string
		advertise string
		ttl       time.Duration
		force     bool
	)

	cmd := &cobra.Command{
		Use:   "attach",
		Short: "Run a workspace and stream file changes as JSON on stdout",
		Long: "Attaches to a workspace and emits one JSON object per line on stdout:\n" +
			"an 'invite' frame when hosting, a 'ready' frame once the session is up,\n" +
			"then a 'change' frame for every file change made here or applied from a\n" +
			"peer.\n\n" +
			"Use --serve to host, or --join with a code to pair. With neither, the\n" +
			"recorded role decides: a folder that already paired reconnects.\n\n" +
			"A consumer must treat 'change' bodies as ephemeral. The patch field is for\n" +
			"display and must never be written to durable storage; the hashes are the\n" +
			"record of what changed.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if serve && joinCode != "" {
				return errors.New("--serve and --join are mutually exclusive")
			}

			root, err := filepath.Abs(".")
			if err != nil {
				return err
			}

			frames := newFrameWriter(stdout)
			ctx, stop := signalContext(cmd.Context())
			defer stop()

			// The control relay is one object used for both directions, so the
			// side that sends and the side that receives cannot disagree about
			// which peer they are talking to.
			relay := &session.Control{}
			relay.Receive = func(frame sync.Control) {
				if err := frames.control(frame.Payload); err != nil {
					_ = frames.failure(fmt.Sprintf("write control frame: %v", err))
				}
			}
			go func() {
				if err := relayStdin(ctx, stdin, relay, func(err error) {
					_ = frames.failure(fmt.Sprintf("control relay: %v", err))
				}); err != nil && ctx.Err() == nil {
					// The supervisor closed its end. That is the normal way a
					// supervisor says goodbye, so it is reported and the session
					// keeps running rather than tearing down the file sync.
					_ = frames.failure(err.Error())
				}
			}()

			switch {
			case serve:
				return attachServe(ctx, root, frames, serveOptions{
					ListenAddr: listen,
					JoinHost:   advertise,
					CodeTTL:    ttl,
					Stdout:     stdout,
					Stderr:     stderr,
					Controls:   relay,
				})

			case joinCode != "":
				return attachJoin(ctx, root, frames, joinOptions{
					Code: joinCode,
					// Re-pairing an already-paired folder is deliberate, so it
					// needs the flag rather than happening by accident.
					Force:    force,
					Controls: relay,
				})

			default:
				// With neither flag the recorded role decides, which is what lets
				// a supervisor restart a session without knowing how it was first
				// established.
				ws, err := workspace.Open(root)
				if err != nil {
					return errors.New("this folder is not a workspace yet: run 'workspace create' then 'attach --serve', or pass 'attach --join <code>'")
				}
				role := ws.Role
				_ = ws.Close()

				switch role {
				case workspace.RoleHost:
					return attachServe(ctx, root, frames, serveOptions{
						ListenAddr: listen,
						JoinHost:   advertise,
						CodeTTL:    ttl,
						Stdout:     stdout,
						Stderr:     stderr,
						Controls:   relay,
					})
				case workspace.RoleMember:
					return attachJoin(ctx, root, frames, joinOptions{Controls: relay})
				default:
					return errors.New("this folder has no recorded role: run 'attach --serve' or 'attach --join <code>'")
				}
			}
		},
	}

	cmd.Flags().BoolVar(&serve, "serve", false, "host this workspace")
	cmd.Flags().StringVar(&joinCode, "join", "", "join a workspace using a one-time join code")
	cmd.Flags().StringVar(&listen, "listen", "127.0.0.1:0", "address to bind when hosting")
	cmd.Flags().StringVar(&advertise, "advertise", "", "host address to put in the join code")
	cmd.Flags().DurationVar(&ttl, "code-ttl", 0, "lifetime of the join code (default 15m)")
	cmd.Flags().BoolVar(&force, "force-pairing", false, "redeem a join code even when this folder is already paired")
	return cmd
}

// attachServe hosts the workspace and emits a ready frame once it is listening.
//
// It opens the workspace itself. A hosting folder must already exist, because
// there is nothing to host otherwise, and the error says so rather than
// inventing one.
func attachServe(ctx context.Context, root string, frames *frameWriter, opts serveOptions) error {
	ws, err := workspace.Open(root)
	if err != nil {
		return err
	}
	defer ws.Close()

	if err := ws.SetRole(workspace.RoleHost); err != nil {
		return err
	}

	opts.OnEvent = func(e sync.Event) { _ = frames.event(e) }
	opts.OnChange = func(ev sync.ChangeEvent) { _ = frames.change(ev) }

	// Serve blocks until the context is cancelled, so the ready frame is emitted
	// from the callback, which is the first moment the address is known and the
	// engine is watching. Announcing readiness any earlier would let a consumer
	// edit a file before the watcher exists.
	ready := false
	opts.OnReady = func(res *session.ServeResult) {
		ready = true
		if err := frames.ready(ws, root, res.BoundAddr, ""); err != nil {
			_ = frames.failure(fmt.Sprintf("write ready frame: %v", err))
		}
	}
	// The join code is a frame as well as a human-facing line. A supervisor that
	// captured this process's stdout has no terminal, and the user still needs
	// the code to pair the other machine.
	opts.OnCode = func(payload security.JoinCodePayload, _ string) {
		grouped := security.FormatJoinCodeGrouped(payload)
		if err := frames.invite(grouped, security.FormatJoinCodeURL(payload), payload.ExpiresAt); err != nil {
			_ = frames.failure(fmt.Sprintf("write invite frame: %v", err))
		}
	}
	// The human-facing code print is suppressed: stdout belongs to the stream, and
	// stderr would duplicate a code that the invite frame already carries.
	opts.Stderr = io.Discard

	_, err = serveWorkspace(ctx, ws, opts)
	if err != nil {
		if !ready {
			_ = frames.failure(err.Error())
		}
		return err
	}
	return nil
}

// attachJoin pairs or reconnects, then streams until the link ends.
//
// Unlike serve it does not open the workspace first: a first join into an empty
// folder has to create it, and the session does that. The handle arrives on the
// ready callback instead, which is the first point at which it exists.
func attachJoin(ctx context.Context, root string, frames *frameWriter, opts joinOptions) error {
	opts.Live = true
	opts.Policy = workspace.DefaultApplyPolicy()
	opts.OnEvent = func(e sync.Event) { _ = frames.event(e) }
	opts.OnChange = func(ev sync.ChangeEvent) { _ = frames.change(ev) }
	opts.OnReady = func(ws *workspace.Workspace, _ *sync.SyncReport) {
		// The host fingerprint is read here, after pairing has recorded it,
		// rather than before: on a first join it does not exist until the host's
		// certificate has been pinned.
		if err := frames.ready(ws, root, "", hostFingerprint(ws)); err != nil {
			_ = frames.failure(fmt.Sprintf("write ready frame: %v", err))
		}
	}
	// The human-facing summary is suppressed: stdout belongs to the frame stream.
	opts.Stdout = io.Discard
	opts.Stderr = io.Discard

	// A live join returns only when the link ends. It closes the workspace itself
	// on error, and the caller owns the handle otherwise.
	handle, _, err := joinWorkspace(ctx, root, opts)
	if err != nil {
		_ = frames.failure(err.Error())
		return err
	}
	if handle != nil {
		defer handle.Close()
	}
	return nil
}
