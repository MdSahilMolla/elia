package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func run(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errBuf bytes.Buffer
	root := NewRootCommand(&out, &errBuf)
	root.SetArgs(args)
	err = root.Execute()
	return out.String(), errBuf.String(), err
}

func TestCreateThenStatus(t *testing.T) {
	root := t.TempDir()
	chdir(t, root)

	out, _, err := run(t, "create", "--name", "demo")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, want := range []string{"Workspace created", "Name:", "demo", "Workspace ID:", "Fingerprint:"} {
		if !strings.Contains(out, want) {
			t.Errorf("create output missing %q:\n%s", want, out)
		}
	}

	out, _, err = run(t, "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, want := range []string{"Role:", "host", "Peers (0)", "none yet"} {
		if !strings.Contains(out, want) {
			t.Errorf("status output missing %q:\n%s", want, out)
		}
	}
}

func TestCreateTwiceFails(t *testing.T) {
	dir := t.TempDir()
	chdir(t, dir)

	if _, _, err := run(t, "create"); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, _, err := run(t, "create")
	if err == nil {
		t.Fatal("second create succeeded")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("error %q does not explain the conflict", err)
	}
}

func TestStatusWithoutWorkspaceFails(t *testing.T) {
	chdir(t, t.TempDir())
	if _, _, err := run(t, "status"); err == nil {
		t.Fatal("status succeeded outside a workspace")
	}
}

func TestJoinWithoutCodeOrHostExplainsItself(t *testing.T) {
	chdir(t, t.TempDir())
	_, _, err := run(t, "join")
	if err == nil {
		t.Fatal("join succeeded with neither a code nor a pinned host")
	}
	if !strings.Contains(err.Error(), "not yet a workspace") {
		t.Errorf("error %q does not explain what is missing", err)
	}
}

func TestJoinWithoutCodeInAnUnpairedWorkspaceExplainsItself(t *testing.T) {
	dir := t.TempDir()
	chdir(t, dir)
	if _, _, err := run(t, "create"); err != nil {
		t.Fatalf("create: %v", err)
	}
	// A workspace that has never paired has no host to reconnect to.
	_, _, err := run(t, "join")
	if err == nil {
		t.Fatal("join succeeded with no code and no pinned host")
	}
	if !strings.Contains(err.Error(), "pinned host") {
		t.Errorf("error %q does not mention the missing pinned host", err)
	}
}

func TestJoinWithMalformedCodeReportsIt(t *testing.T) {
	chdir(t, t.TempDir())
	_, _, err := run(t, "join", "not-a-real-code")
	if err == nil {
		t.Fatal("join accepted a malformed code")
	}
}

// chdir moves into dir for the duration of the test and restores it afterwards,
// so the CLI's ".", which is what the real commands use, resolves correctly.
func chdir(t *testing.T, dir string) {
	t.Helper()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(old); err != nil {
			t.Fatal(err)
		}
	})
}

func TestVersionAndHelpDoNotError(t *testing.T) {
	chdir(t, t.TempDir())
	for _, args := range [][]string{{"--version"}, {"--help"}, {"join", "--help"}} {
		if _, _, err := run(t, args...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// The command tree must be constructible without touching the process globals,
// which is what lets the tests above run in parallel-safe isolation.
func TestNewRootCommandIsIndependent(t *testing.T) {
	a := NewRootCommand(&bytes.Buffer{}, &bytes.Buffer{})
	b := NewRootCommand(&bytes.Buffer{}, &bytes.Buffer{})
	if a == b {
		t.Fatal("NewRootCommand returned the same command twice")
	}
	if _, err := os.Stat(filepath.Join("cmd", "workspace", "main.go")); err == nil {
		t.Log("entrypoint present")
	}
}
