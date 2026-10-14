package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
	"elia-go/internal/mesh/workspace"
)

// newConflictsCommand lists the divergences this workspace has refused to resolve
// on its own.
//
// It exists because the design decision was to preserve rather than merge, and a
// decision the tool makes on the user's behalf is a decision they cannot see. If
// there is no way to ask what went wrong, "preserve" just means "silently do
// nothing and hope it does not matter".
func newConflictsCommand(stdout, stderr io.Writer) *cobra.Command {
	var all bool

	cmd := &cobra.Command{
		Use:   "conflicts",
		Short: "List files that differ on both sides",
		Long: "Lists the files this workspace would not overwrite, newest first.\n\n" +
			"Each one has two versions: the file in your folder, and the copy the peer's\n" +
			"version was saved to under " + workspace.ConflictDirName + ". Neither was\n" +
			"discarded. Use 'workspace resolve' to say which one to keep.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := workspace.Open(".")
			if err != nil {
				return err
			}
			defer ws.Close()

			var rows []store.ConflictRow
			if all {
				rows, err = ws.Store.AllConflicts()
			} else {
				rows, err = ws.Store.UnresolvedConflicts()
			}
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				if all {
					fmt.Fprintln(stdout, "No conflicts have been recorded in this workspace.")
				} else {
					fmt.Fprintln(stdout, "No unresolved conflicts.")
				}
				return nil
			}

			for _, c := range rows {
				state := "unresolved"
				if c.Resolved {
					state = "resolved: " + c.Resolution
				}
				fmt.Fprintf(stdout, "\n#%d  %s  (%s)\n", c.ID, c.Path, state)
				fmt.Fprintf(stdout, "  kind:      %s\n", c.Kind)
				fmt.Fprintf(stdout, "  peer:      %s\n", c.PeerID)
				fmt.Fprintf(stdout, "  versions:  base %d, yours %d, theirs %d\n",
					c.BaseVersion, c.LocalVersion, c.RemoteVersion)
				fmt.Fprintf(stdout, "  detected:  %s\n", c.DetectedAt.Local().Format("2006-01-02 15:04:05"))
				if c.KeptPath != "" {
					fmt.Fprintf(stdout, "  their copy: %s\n", c.KeptPath)
				}
			}

			if !all {
				fmt.Fprintf(stdout, "\nResolve one with: workspace resolve <id> --keep-mine | --keep-theirs\n")
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&all, "all", false, "include conflicts that have already been resolved")
	return cmd
}

// newResolveCommand applies the user's decision about one conflict.
func newResolveCommand(stdout, stderr io.Writer) *cobra.Command {
	var (
		keepMine    bool
		keepTheirs  bool
		keepBoth    bool
		discardCopy bool
	)

	cmd := &cobra.Command{
		Use:   "resolve <conflict-id>",
		Short: "Decide what to do about a conflict",
		Long: "Applies your decision to one conflict and records it.\n\n" +
			"  --keep-mine     keep the file as it is, and remember that you chose it\n" +
			"  --keep-theirs   replace your file with the peer's preserved copy\n" +
			"  --keep-both     append the peer's copy to your file, marked, with both intact\n" +
			"  --discard       keep your file and delete the preserved copy\n\n" +
			"Every option except --keep-theirs and --keep-both leaves your file untouched.\n" +
			"Nothing is deleted unless you ask for it.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			chosen := 0
			for _, b := range []bool{keepMine, keepTheirs, keepBoth, discardCopy} {
				if b {
					chosen++
				}
			}
			if chosen == 0 {
				return fmt.Errorf("say what to do: pass one of --keep-mine, --keep-theirs, --keep-both, --discard")
			}
			if chosen > 1 {
				return fmt.Errorf("pass only one of --keep-mine, --keep-theirs, --keep-both, --discard")
			}

			id, err := strconv.ParseInt(args[0], 10, 64)
			if err != nil {
				return fmt.Errorf("%q is not a conflict id", args[0])
			}

			ws, err := workspace.Open(".")
			if err != nil {
				return err
			}
			defer ws.Close()

			conflict, err := ws.Store.ConflictByID(id)
			if err != nil {
				return err
			}
			if conflict.Resolved {
				return fmt.Errorf("conflict #%d was already resolved as %q", id, conflict.Resolution)
			}

			resolution, err := applyResolution(ws, conflict,
				keepMine, keepTheirs, keepBoth, discardCopy)
			if err != nil {
				return err
			}
			if err := ws.Store.ResolveConflict(id, resolution); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "Conflict #%d on %s resolved: %s\n", id, conflict.Path, resolution)
			return nil
		},
	}

	cmd.Flags().BoolVar(&keepMine, "keep-mine", false, "keep the file in this folder and leave the peer's copy in place")
	cmd.Flags().BoolVar(&keepTheirs, "keep-theirs", false, "replace the file with the peer's preserved copy")
	cmd.Flags().BoolVar(&keepBoth, "keep-both", false, "append the peer's copy to the file, keeping both texts")
	cmd.Flags().BoolVar(&discardCopy, "discard", false, "keep the file and delete the preserved copy")
	return cmd
}

// applyResolution performs the decision and returns the label to record.
//
// The file is only ever written when the user asked for their content to win, and
// the write goes through the same validated path helpers as everything else, so a
// stored conflict path cannot be used to write outside the workspace.
func applyResolution(
	ws *workspace.Workspace,
	conflict store.ConflictRow,
	keepMine, keepTheirs, keepBoth, discard bool,
) (string, error) {
	mine, err := security.SecureJoin(ws.Root, conflict.Path)
	if err != nil {
		return "", err
	}
	keptAbs, keptErr := security.SecureJoin(ws.Root, conflict.KeptPath)

	switch {
	case keepMine:
		// Nothing to do: the file is already what the user wants.
		return "kept mine", nil

	case discard:
		if conflict.KeptPath == "" {
			return "", fmt.Errorf("conflict #%d has no preserved copy to delete", conflict.ID)
		}
		if keptErr != nil {
			return "", keptErr
		}
		if err := os.Remove(keptAbs); err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("remove %s: %w", conflict.KeptPath, err)
		}
		return "kept mine, discarded their copy", nil

	case keepTheirs:
		if keptErr != nil {
			return "", fmt.Errorf("conflict #%d has no preserved copy to keep: %w", conflict.ID, keptErr)
		}
		content, err := os.ReadFile(keptAbs)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", conflict.KeptPath, err)
		}
		if err := writeThroughWorkspace(ws, conflict.Path, content); err != nil {
			return "", err
		}
		return "took their copy", nil

	case keepBoth:
		if keptErr != nil {
			return "", fmt.Errorf("conflict #%d has no preserved copy to merge: %w", conflict.ID, keptErr)
		}
		theirs, err := os.ReadFile(keptAbs)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", conflict.KeptPath, err)
		}
		mineContent, err := os.ReadFile(mine)
		if err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("read %s: %w", conflict.Path, err)
		}
		merged := appendBoth(mineContent, theirs, conflict.Path)
		if err := writeThroughWorkspace(ws, conflict.Path, merged); err != nil {
			return "", err
		}
		return "kept both", nil
	}
	return "", fmt.Errorf("no resolution chosen")
}

// appendBoth joins two versions with a marker naming where the peer's text came
// from, so the file is still valid to read and still says what happened.
func appendBoth(mine, theirs []byte, path string) []byte {
	var b strings.Builder
	b.Write(mine)
	if len(mine) > 0 && !strings.HasSuffix(string(mine), "\n") {
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "\n<<<<<<< merged from %s, kept alongside the version above >>>>>>>\n", path)
	b.Write(theirs)
	if len(theirs) > 0 && theirs[len(theirs)-1] != '\n' {
		b.WriteString("\n")
	}
	return []byte(b.String())
}

// writeThroughWorkspace writes inside the workspace and refreshes the tracked
// state, so a resolved file is not immediately seen as a fresh local edit by the
// next session.
func writeThroughWorkspace(ws *workspace.Workspace, rel string, content []byte) error {
	abs, err := security.SecureMkdirAll(ws.Root, rel)
	if err != nil {
		return err
	}
	if err := workspace.WriteFileAtomic(abs, content, 0o644); err != nil {
		return err
	}
	hash := workspace.HashBytes(content)
	// The version is not advanced here on purpose: the tracked version belongs to
	// the agreement protocol, and a hand-merged file is a local decision that the
	// next change to this path will be based on. Recording the hash is what stops
	// the unchanged file from being treated as an unsent edit.
	row, err := ws.Store.GetFile(rel)
	if err == nil {
		if _, err := ws.AdvanceFile(rel, int64(len(content)), hash, row.Version); err != nil {
			return err
		}
		return nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	_, err = ws.AdvanceFile(rel, int64(len(content)), hash, 1)
	return err
}

// sampleTrackedFiles returns up to limit tracked paths, in a stable order, so
// status can name real files without listing a whole project.
func sampleTrackedFiles(ws *workspace.Workspace, limit int) ([]string, error) {
	rows, err := ws.Store.AllFiles()
	if err != nil {
		return nil, err
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	out := make([]string, 0, limit)
	for _, r := range rows {
		if len(out) == limit {
			break
		}
		out = append(out, r.Path)
	}
	return out, nil
}
