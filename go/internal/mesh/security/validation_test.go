package security

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRelPathRejectsTraversal(t *testing.T) {
	// Every one of these arrived from a peer in some version of this code, or
	// would if the checks were removed.
	cases := []struct {
		name string
		path string
	}{
		{"dotdot escape", "../../.ssh/id_rsa"},
		{"dotdot mid path", "src/../../etc/passwd"},
		{"dotdot as only segment", ".."},
		{"dotdot trailing", "src/.."},
		{"absolute path", "/etc/passwd"},
		{"absolute home", "/root/.ssh/id_rsa"},
		{"dot slash", "./src/app.py"},
		{"dot mid path", "src/./app.py"},
		{"empty path", ""},
		{"double slash", "src//app.py"},
		{"trailing slash", "src/app.py/"},
		{"nul byte", "src/app\x00.py"},
		{"backslash", `src\app.py`},
		{"windows drive", "C:/Windows/system32"},
		{"unix drive", "C:x"},
		{"invalid utf8", "src/\xff\xfe.py"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateRelPath(tc.path); err == nil {
				t.Errorf("ValidateRelPath(%q) = nil, want rejection", tc.path)
			}
		})
	}
}

func TestValidateRelPathAccepts(t *testing.T) {
	cases := []string{
		"README.md",
		"src/app.py",
		"src/utils.py",
		"a/b/c/d/e/f.txt",
		"file with spaces.txt",
		"dots.in.name.tar.gz",
		"..hidden",
		"a..b",
		"ünïcodé.txt",
	}

	for _, p := range cases {
		t.Run(p, func(t *testing.T) {
			if err := ValidateRelPath(p); err != nil {
				t.Errorf("ValidateRelPath(%q) = %v, want nil", p, err)
			}
		})
	}
}

func TestValidateRelPathLengthAndDepth(t *testing.T) {
	deep := strings.Repeat("a/", MaxPathSegments) + "f.txt"
	if err := ValidateRelPath(deep); err == nil {
		t.Error("over-deep path accepted, want rejection")
	}

	long := strings.Repeat("x", MaxPathLen+1)
	if err := ValidateRelPath(long); err == nil {
		t.Error("over-long path accepted, want rejection")
	}
}

func TestSecureJoinInsideRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := SecureJoin(root, "src/app.py")
	if err != nil {
		t.Fatalf("SecureJoin: %v", err)
	}
	want := filepath.Join(root, "src", "app.py")
	if got != want {
		t.Errorf("SecureJoin = %q, want %q", got, want)
	}
}

// The core symlink threat: a symlinked *parent* directory. Cleaning and
// prefix-checking passes this path, because the cleaned result still begins
// with root. Only the per-component walk catches it.
func TestSecureJoinRejectsSymlinkedParent(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	if _, err := SecureJoin(root, "link/secret.txt"); err == nil {
		t.Error("SecureJoin through a symlinked directory succeeded, want rejection")
	} else if !strings.Contains(err.Error(), "symlink") {
		t.Errorf("error = %v, want it to mention symlink", err)
	}
}

func TestSecureJoinRejectsSymlinkedLeaf(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	target := filepath.Join(base, "outside.txt")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "sneaky.txt")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	if _, err := SecureJoin(root, "sneaky.txt"); err == nil {
		t.Error("SecureJoin to a symlinked file succeeded, want rejection")
	}
}

func TestSecureJoinAllowsMissingLeaf(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := SecureJoin(root, "src/new-file.py")
	if err != nil {
		t.Fatalf("SecureJoin for a new file: %v", err)
	}
	if _, err := os.Lstat(got); !os.IsNotExist(err) {
		t.Errorf("expected the resolved path not to exist yet, got %v", err)
	}
}

func TestSecureJoinRejectsMissingParent(t *testing.T) {
	root := t.TempDir()
	if _, err := SecureJoin(root, "no/such/dir/file.txt"); err == nil {
		t.Error("SecureJoin with a missing parent succeeded, want rejection")
	}
}

func TestSecureJoinRejectsFileAsParent(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "afile"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := SecureJoin(root, "afile/child.txt"); err == nil {
		t.Error("SecureJoin through a regular file succeeded, want rejection")
	}
}

func TestSecureJoinRejectsSymlinkedRoot(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, err := SecureJoin(link, "file.txt"); err == nil {
		t.Error("SecureJoin with a symlinked root succeeded, want rejection")
	}
}

func TestSecureJoinRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	if _, err := SecureJoin(root, "../../etc/passwd"); err == nil {
		t.Error("traversal succeeded, want rejection")
	}
}

func TestValidateFileForSync(t *testing.T) {
	root := t.TempDir()
	content := []byte("print('hello')\n")
	if err := os.WriteFile(filepath.Join(root, "app.py"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateFileForSync(root, "app.py", int64(len(content)), false); err != nil {
		t.Errorf("ValidateFileForSync on a regular file: %v", err)
	}

	if _, err := ValidateFileForSync(root, "app.py", int64(len(content))+1, false); err == nil {
		t.Error("size mismatch accepted, want rejection")
	}

	if _, err := ValidateFileForSync(root, "app.py", MaxFileSize+1, true); !errors.Is(err, ErrTooLarge) {
		t.Errorf("oversize file err = %v, want ErrTooLarge", err)
	}

	if _, err := ValidateFileForSync(root, "app.py", -1, true); err == nil {
		t.Error("negative size accepted, want rejection")
	}

	if _, err := ValidateFileForSync(root, "missing.py", 0, false); err == nil {
		t.Error("missing file with missingOK=false accepted, want rejection")
	}
	if _, err := ValidateFileForSync(root, "missing.py", 0, true); err != nil {
		t.Errorf("missing file with missingOK=true: %v", err)
	}
}

func TestValidateFileForSyncRejectsDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateFileForSync(root, "src", 0, false); !errors.Is(err, ErrNotRegularFile) {
		t.Errorf("directory err = %v, want ErrNotRegularFile", err)
	}
}

func TestValidateWorkspaceID(t *testing.T) {
	valid := []string{"ws_83f92a", "ws_000000", "ws_ABCDEF"}
	for _, id := range valid {
		if err := ValidateWorkspaceID(id); err != nil {
			t.Errorf("ValidateWorkspaceID(%q) = %v, want nil", id, err)
		}
	}

	invalid := []string{"", "ws_", "ws_12345", "ws_1234567", "83f92a", "xx_83f92a", "ws_83f92z", "ws_83f9 2", "../ws_83f92a"}
	for _, id := range invalid {
		if err := ValidateWorkspaceID(id); err == nil {
			t.Errorf("ValidateWorkspaceID(%q) = nil, want rejection", id)
		}
	}
}

func TestValidatePeerID(t *testing.T) {
	if err := ValidatePeerID("a1b2c3"); err != nil {
		t.Errorf("ValidatePeerID(a1b2c3) = %v, want nil", err)
	}
	for _, id := range []string{"", "abc", "a1b2c3d4", "a1b2c", "zzzzzz"} {
		if err := ValidatePeerID(id); err == nil {
			t.Errorf("ValidatePeerID(%q) = nil, want rejection", id)
		}
	}
}

func TestNewWorkspaceIDFormat(t *testing.T) {
	id, err := NewWorkspaceID()
	if err != nil {
		t.Fatalf("NewWorkspaceID: %v", err)
	}
	if err := ValidateWorkspaceID(id); err != nil {
		t.Errorf("minted id %q fails validation: %v", id, err)
	}
}

func TestNewWorkspaceIDIsUnique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id, err := NewWorkspaceID()
		if err != nil {
			t.Fatal(err)
		}
		if seen[id] {
			t.Fatalf("duplicate workspace id %q after %d draws", id, i)
		}
		seen[id] = true
	}
}
