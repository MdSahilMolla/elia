package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"elia-go/internal/mesh/p2p"
	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
)

// Metadata keys persisted in the state database.
const (
	MetaWorkspaceID = "workspace_id"
	MetaPeerID      = "peer_id"
	MetaRole        = "role"
	MetaName        = "name"
	MetaCreatedAt   = "created_at"
	// Set by serve: the address a join code should point at.
	MetaJoinHost = "join_host"
	MetaJoinPort = "join_port"
	// Set by join: the host's pinned certificate and address, so a later
	// reconnect needs no join code.
	MetaHostCert   = "host_cert_sha256"
	MetaRemoteHost = "remote_host"
	MetaRemotePort = "remote_port"
	// Incremented every time a join code is minted, so serve can tell whether
	// the code it is about to print is still unused.
	MetaJoinCodeGeneration = "join_code_generation"
	MetaProtocolRev        = "protocol_revision"
)

// Roles a workspace peer can hold.
const (
	RoleHost   = "host"
	RoleMember = "member"
)

// ErrAlreadyExists means create was called on an existing workspace.
var ErrAlreadyExists = errors.New("a workspace already exists at this path")

// Workspace is one peer's view of a synchronised folder.
type Workspace struct {
	Root    string
	Store   *store.Store
	Ignore  *IgnoreSet
	ID      string
	PeerID  string
	Role    string
	Name    string
	Created time.Time

	identity *p2p.Identity
}

// StateDir is the per-workspace control directory.
func (w *Workspace) StateDir() string {
	return filepath.Join(w.Root, store.StateDirName)
}

// Identity returns the peer's certificate and key, loading or generating them
// on first use.
func (w *Workspace) Identity() (*p2p.Identity, error) {
	if w.identity != nil {
		return w.identity, nil
	}
	id, err := p2p.LoadOrCreateIdentity(w.StateDir(), w.PeerID)
	if err != nil {
		return nil, err
	}
	w.identity = id
	return id, nil
}

// FingerprintHex is this peer's full certificate fingerprint, hex encoded.
func (w *Workspace) FingerprintHex() (string, error) {
	id, err := w.Identity()
	if err != nil {
		return "", err
	}
	return id.FingerprintHex(), nil
}

// Exists reports whether a workspace has already been created at root.
func Exists(root string) bool {
	_, err := os.Stat(filepath.Join(root, store.StateDirName, store.DBFileName))
	return err == nil
}

// CreateOptions configures workspace creation.
type CreateOptions struct {
	// Name is a human label; it defaults to the directory's base name.
	Name string
	// TTL bounds the first join code's lifetime.
	TTL time.Duration
	// MaxUses is how many peers the first code may admit.
	MaxUses int
	// AdoptWorkspaceID makes a joining peer adopt the host's workspace id
	// instead of generating one. The id names the workspace, not the local
	// copy of it, so every peer in a workspace must agree on it; a peer that
	// generates its own would produce manifests that never match.
	AdoptWorkspaceID string
}

// Create initialises a workspace at root: it creates the state database, mints
// a workspace id and peer identity, and records the metadata. It does not mint
// a join code, since the listen address is not known until the host serves.
func Create(root string, opts CreateOptions) (*Workspace, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace path: %w", err)
	}
	if Exists(absRoot) {
		return nil, fmt.Errorf("%w: %s", ErrAlreadyExists, absRoot)
	}
	if err := os.MkdirAll(absRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create workspace directory: %w", err)
	}

	st, err := store.Open(absRoot)
	if err != nil {
		return nil, err
	}

	wsID := opts.AdoptWorkspaceID
	if wsID == "" {
		if wsID, err = security.NewWorkspaceID(); err != nil {
			st.Close()
			return nil, err
		}
	} else if err := security.ValidateWorkspaceID(wsID); err != nil {
		st.Close()
		return nil, fmt.Errorf("workspace id to adopt is invalid: %w", err)
	}
	peerID, err := security.NewPeerID()
	if err != nil {
		st.Close()
		return nil, err
	}

	name := opts.Name
	if name == "" {
		name = filepath.Base(absRoot)
	}
	created := time.Now().UTC()

	meta := map[string]string{
		MetaWorkspaceID: wsID,
		MetaPeerID:      peerID,
		MetaRole:        RoleHost,
		MetaName:        name,
		MetaCreatedAt:   created.Format(time.RFC3339Nano),
		MetaProtocolRev: fmt.Sprintf("%d", currentProtocolRevision),
	}
	for k, v := range meta {
		if err := st.SetMeta(k, v); err != nil {
			st.Close()
			return nil, fmt.Errorf("write metadata %s: %w", k, err)
		}
	}

	w := &Workspace{
		Root:    absRoot,
		Store:   st,
		Ignore:  DefaultIgnoreSet(),
		ID:      wsID,
		PeerID:  peerID,
		Role:    RoleHost,
		Name:    name,
		Created: created,
	}
	// Generate the identity now so create fails early on a bad filesystem
	// rather than at serve time.
	if _, err := w.Identity(); err != nil {
		st.Close()
		return nil, err
	}
	return w, nil
}

// Open loads an existing workspace.
func Open(root string) (*Workspace, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace path: %w", err)
	}
	if !Exists(absRoot) {
		return nil, fmt.Errorf("no workspace at %s: run 'workspace create' first", absRoot)
	}

	st, err := store.Open(absRoot)
	if err != nil {
		return nil, err
	}

	w := &Workspace{Root: absRoot, Store: st, Ignore: DefaultIgnoreSet()}
	if w.ID, err = st.GetMeta(MetaWorkspaceID); err != nil {
		st.Close()
		return nil, err
	}
	if err := security.ValidateWorkspaceID(w.ID); err != nil {
		st.Close()
		return nil, fmt.Errorf("stored workspace id is invalid: %w", err)
	}
	if w.PeerID, err = st.GetMeta(MetaPeerID); err != nil {
		st.Close()
		return nil, err
	}
	if err := security.ValidatePeerID(w.PeerID); err != nil {
		st.Close()
		return nil, fmt.Errorf("stored peer id is invalid: %w", err)
	}
	w.Role, _ = st.GetMeta(MetaRole)
	w.Name, _ = st.GetMeta(MetaName)
	if created, err := st.GetMeta(MetaCreatedAt); err == nil {
		w.Created, _ = time.Parse(time.RFC3339Nano, created)
	}
	return w, nil
}

// Close releases the state database.
func (w *Workspace) Close() error { return w.Store.Close() }

// SetMeta writes one metadata value.
func (w *Workspace) SetMeta(key, value string) error { return w.Store.SetMeta(key, value) }

// GetMeta reads one metadata value.
func (w *Workspace) GetMeta(key string) (string, error) { return w.Store.GetMeta(key) }

// SetRole records whether this peer hosts or merely joined.
func (w *Workspace) SetRole(role string) error {
	if role != RoleHost && role != RoleMember {
		return fmt.Errorf("unknown role %q", role)
	}
	w.Role = role
	return w.Store.SetMeta(MetaRole, role)
}

// TotalTrackedBytes sums the sizes of tracked files.
func (w *Workspace) TotalTrackedBytes() (int64, error) {
	files, err := w.Store.AllFiles()
	if err != nil {
		return 0, err
	}
	var n int64
	for _, f := range files {
		n += f.Size
	}
	return n, nil
}

// RefreshManifest rebuilds the manifest from disk, reusing stored versions so a
// file's version only advances when its content actually changes.
func (w *Workspace) RefreshManifest() (*Manifest, []string, error) {
	rows, err := w.Store.AllFiles()
	if err != nil {
		return nil, nil, err
	}
	versions := make(map[string]int64, len(rows))
	known := make(map[string]string, len(rows))
	for _, r := range rows {
		versions[r.Path] = r.Version
		known[r.Path] = r.SHA256
	}

	m, skipped, err := BuildManifest(w.Root, w.ID, versions, w.Ignore)
	if err != nil {
		return nil, nil, err
	}

	// A file whose content matches its stored hash keeps its version; anything
	// else is a local edit and moves to the next version.
	for i := range m.Files {
		prevHash, existed := known[m.Files[i].Path]
		switch {
		case !existed:
			m.Files[i].Version = 1
		case prevHash != m.Files[i].Hash:
			m.Files[i].Version = versions[m.Files[i].Path] + 1
		default:
			m.Files[i].Version = versions[m.Files[i].Path]
		}
	}
	return m, skipped, nil
}
