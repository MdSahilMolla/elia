// Package cli builds the workspace command tree.
package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// Version is the build revision, overridable at link time.
var Version = "0.1.0"

// NewRootCommand builds the command tree with output wired to the given
// streams, so tests can drive the CLI without touching the process globals.
func NewRootCommand(stdout, stderr io.Writer) *cobra.Command {
	return newRootCommand(os.Stdin, stdout, stderr)
}

// newRootCommand takes stdin explicitly so a test can drive the control relay
// without a real terminal, which is the only way the supervisor-facing half of
// this program can be tested.
func newRootCommand(stdin io.Reader, stdout, stderr io.Writer) *cobra.Command {
	root := &cobra.Command{
		Use:   "workspace",
		Short: "Peer-to-peer collaborative workspace",
		Long: "A peer-to-peer collaborative filesystem.\n\n" +
			"Peer A creates a workspace and hosts it. Peer B joins with a one-time\n" +
			"join code, and the two folders are synchronised over an authenticated,\n" +
			"encrypted peer-to-peer connection.",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       Version,
	}

	root.SetOut(stdout)
	root.SetErr(stderr)

	root.AddCommand(
		newCreateCommand(stdout, stderr),
		newServeCommand(stdout, stderr),
		newJoinCommand(stdout, stderr),
		newStatusCommand(stdout, stderr),
		newConflictsCommand(stdout, stderr),
		newResolveCommand(stdout, stderr),
		newAttachCommand(stdin, stdout, stderr),
	)
	return root
}

// eventPrinter renders session events on one line each, which is what makes an
// attached session readable.
func eventPrinter(w io.Writer) func(sync.Event) {
	return func(e sync.Event) {
		ts := e.Time.Format("15:04:05")
		switch e.Kind {
		case sync.EventError:
			fmt.Fprintf(w, "%s  error  %s\n", ts, e.Message)
		case sync.EventSyncProgress:
			fmt.Fprintf(w, "%s  sync   %s\n", ts, e.Message)
		case sync.EventSyncComplete, sync.EventConnected:
			fmt.Fprintf(w, "%s  ok     %s\n", ts, e.Message)
		case sync.EventDisconnected:
			fmt.Fprintf(w, "%s  close  %s\n", ts, e.Message)
		default:
			fmt.Fprintf(w, "%s  info   %s\n", ts, e.Message)
		}
	}
}

func newCreateCommand(stdout, stderr io.Writer) *cobra.Command {
	var (
		name string
		ttl  time.Duration
	)

	cmd := &cobra.Command{
		Use:   "create [path]",
		Short: "Create a workspace folder",
		Long: "Creates a workspace directory, assigns it an identifier, and generates\n" +
			"the peer's long-lived cryptographic identity.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := "."
			if len(args) == 1 {
				path = args[0]
			}

			ws, err := workspace.Create(path, workspace.CreateOptions{Name: name, TTL: ttl})
			if err != nil {
				return err
			}
			defer ws.Close()

			fingerprint, err := ws.FingerprintHex()
			if err != nil {
				return err
			}

			fmt.Fprintf(stdout, "Workspace created.\n\n")
			fmt.Fprintf(stdout, "  Root:         %s\n", ws.Root)
			fmt.Fprintf(stdout, "  Name:         %s\n", ws.Name)
			fmt.Fprintf(stdout, "  Workspace ID: %s\n", ws.ID)
			fmt.Fprintf(stdout, "  Peer ID:      %s\n", ws.PeerID)
			fmt.Fprintf(stdout, "  Fingerprint:  %s\n", fingerprint)
			fmt.Fprintf(stdout, "\n")
			fmt.Fprintf(stdout, "Next: run 'workspace serve' in this folder to host it and get a join code.\n")
			return nil
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "human-readable workspace name (defaults to the folder name)")
	cmd.Flags().DurationVar(&ttl, "code-ttl", 0, "lifetime of the first join code (default 15m)")
	return cmd
}

func newServeCommand(stdout, stderr io.Writer) *cobra.Command {
	var (
		listen string
		joinIP string
		ttl    time.Duration
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Host this workspace and wait for peers",
		Long: "Opens an encrypted listener, mints a one-time join code, and serves the\n" +
			"workspace to peers that redeem it. Runs in the foreground until\n" +
			"interrupted.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := workspace.Open(".")
			if err != nil {
				return err
			}
			defer ws.Close()

			if err := ws.SetRole(workspace.RoleHost); err != nil {
				return err
			}

			ctx, stop := signalContext(cmd.Context())
			defer stop()

			_, err = serveWorkspace(ctx, ws, serveOptions{
				ListenAddr: listen,
				JoinHost:   joinIP,
				CodeTTL:    ttl,
				Stderr:     stderr,
				Stdout:     stdout,
			})
			return err
		},
	}

	cmd.Flags().StringVar(&listen, "listen", "127.0.0.1:0", "address to bind (use 0.0.0.0 to accept remote peers)")
	cmd.Flags().StringVar(&joinIP, "advertise", "", "host address to put in the join code (defaults to a local IP)")
	cmd.Flags().DurationVar(&ttl, "code-ttl", 0, "lifetime of the join code (default 15m)")
	return cmd
}

func newJoinCommand(stdout, stderr io.Writer) *cobra.Command {
	var (
		force        bool
		forcePairing bool
		once         bool
	)
	cmd := &cobra.Command{
		Use:   "join [code]",
		Short: "Join a workspace and keep syncing changes",
		Long: "With a join code: connects to the host named by the code, authenticates with\n" +
			"the code's secret, and pulls the files this folder is missing.\n\n" +
			"Without one: reconnects to the host this folder is already paired with, using\n" +
			"the certificate fingerprint recorded at pairing time. No code is needed, because\n" +
			"the join code is a one-time capability rather than a lasting credential.\n\n" +
			"After the first transfer the command stays running and sends changes made here\n" +
			"to the host, and applies changes made there. Press Ctrl-C to stop. Use --once to\n" +
			"transfer and exit instead.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var code string
			if len(args) == 1 {
				code = args[0]
			}

			ctx, stop := signalContext(cmd.Context())
			defer stop()

			policy := workspace.DefaultApplyPolicy()
			if force {
				// A destructive overwrite is only ever reachable by asking for it
				// explicitly, and the flag says so in its own help text.
				policy = workspace.ApplyPolicy{OverwriteDivergent: true, PreserveDivergent: true}
			}

			root, err := filepath.Abs(".")
			if err != nil {
				return err
			}

			// A live join only returns when the link ends, so the summary has to be
			// printed from OnReady while the session is up. That callback runs before
			// the workspace handle comes back, so it is given the root it needs
			// rather than the handle.
			printed := false
			ws, report, err := joinWorkspace(ctx, ".", joinOptions{
				Code:   code,
				Force:  forcePairing,
				Policy: policy,
				Stdout: stdout,
				Stderr: stderr,
				Live:   !once,
				OnReady: func(_ *workspace.Workspace, r *sync.SyncReport) {
					if once {
						return
					}
					printed = true
					printInitialSyncSummary(stdout, root, r)
				},
			})
			if err != nil {
				return err
			}
			defer ws.Close()

			if once || !printed {
				printInitialSyncSummary(stdout, root, report)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "overwrite files that differ on both sides (their content is kept as a conflict copy, but yours is replaced)")
	cmd.Flags().BoolVar(&forcePairing, "force-pairing", false, "redeem a join code even when this folder is already paired with a host")
	cmd.Flags().BoolVar(&once, "once", false, "transfer the files and exit instead of staying connected")
	return cmd
}

// printInitialSyncSummary explains what the first transfer did, and what it
// deliberately left alone.
func printInitialSyncSummary(stdout io.Writer, root string, report *sync.SyncReport) {
	if report == nil {
		return
	}
	fmt.Fprintf(stdout, "\n")
	fmt.Fprintf(stdout, "Initial synchronisation complete.\n\n")
	fmt.Fprintf(stdout, "  Workspace:  %s\n", root)
	fmt.Fprintf(stdout, "  Files:      %d received, %d already current\n", report.Transferred, report.Skipped)
	fmt.Fprintf(stdout, "  Duration:   %s\n", report.Duration().Round(time.Millisecond))
	if len(report.LocalOnly) > 0 {
		fmt.Fprintf(stdout, "\n")
		fmt.Fprintf(stdout, "  %d local file(s) are not on the host and were left alone:\n", len(report.LocalOnly))
		for i, p := range report.LocalOnly {
			if i >= 10 {
				fmt.Fprintf(stdout, "    ... and %d more\n", len(report.LocalOnly)-i)
				break
			}
			fmt.Fprintf(stdout, "    %s\n", p)
		}
	}
	if len(report.Divergent) > 0 {
		fmt.Fprintf(stdout, "\n")
		fmt.Fprintf(stdout, "  %d file(s) differ on both sides and were left as they are:\n", len(report.Divergent))
		for i, p := range report.Divergent {
			if i >= 10 {
				fmt.Fprintf(stdout, "    ... and %d more\n", len(report.Divergent)-i)
				break
			}
			fmt.Fprintf(stdout, "    %s\n", p)
		}
		fmt.Fprintf(stdout, "  Run 'workspace conflicts' to see what to do about them.\n")
	}
}

func newStatusCommand(stdout, stderr io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show workspace state",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := workspace.Open(".")
			if err != nil {
				return err
			}
			defer ws.Close()

			fileCount, err := ws.Store.CountFiles()
			if err != nil {
				return err
			}
			totalBytes, err := ws.TotalTrackedBytes()
			if err != nil {
				return err
			}
			peers, err := ws.Store.Peers()
			if err != nil {
				return err
			}

			fmt.Fprintf(stdout, "Workspace\n")
			fmt.Fprintf(stdout, "  Root:         %s\n", ws.Root)
			fmt.Fprintf(stdout, "  Workspace ID: %s\n", ws.ID)
			fmt.Fprintf(stdout, "  Name:         %s\n", ws.Name)
			fmt.Fprintf(stdout, "  Role:         %s\n", ws.Role)
			fmt.Fprintf(stdout, "  Created:      %s\n", ws.Created.Format(time.RFC3339))
			fmt.Fprintf(stdout, "\n")
			fmt.Fprintf(stdout, "Tracked files\n")
			fmt.Fprintf(stdout, "  Count:        %d\n", fileCount)
			fmt.Fprintf(stdout, "  Total size:   %d bytes\n", totalBytes)

			// Unresolved conflicts belong next to the file count, because they are
			// the reason a count might not be what the user expects, and a status
			// command that omits them hides the only thing worth acting on.
			if n, err := ws.Store.CountUnresolvedConflicts(); err == nil && n > 0 {
				fmt.Fprintf(stdout, "  Conflicts:    %d unresolved (run 'workspace conflicts')\n", n)
			}

			// A few names, so a human can tell at a glance whether this is the folder
			// they think it is. The full list is available on request rather than
			// dumped by default, which would bury the summary on a real project.
			if names, err := sampleTrackedFiles(ws, 10); err == nil && len(names) > 0 {
				fmt.Fprintf(stdout, "\n")
				for _, n := range names {
					fmt.Fprintf(stdout, "  %s\n", n)
				}
				if fileCount > len(names) {
					fmt.Fprintf(stdout, "  ... and %d more\n", fileCount-len(names))
				}
			}
			fmt.Fprintf(stdout, "\n")
			fmt.Fprintf(stdout, "Peers (%d)\n", len(peers))
			if len(peers) == 0 {
				fmt.Fprintf(stdout, "  none yet\n")
			}
			for _, p := range peers {
				fmt.Fprintf(stdout, "  %s  %-6s  cert %s...  last seen %s\n",
					p.PeerID, p.Role, shortCert(p.CertSHA256), p.LastSeen.Format(time.RFC3339))
			}

			if host, err := ws.GetMeta(workspace.MetaJoinHost); err == nil {
				if port, err := ws.GetMeta(workspace.MetaJoinPort); err == nil {
					fmt.Fprintf(stdout, "\nLast advertised join address: %s:%s\n", host, port)
				}
			}
			return nil
		},
	}
}

func shortCert(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}

// Execute runs the CLI against the process streams and returns the exit code.
func Execute(args []string) int {
	root := NewRootCommand(os.Stdout, os.Stderr)
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	return 0
}
