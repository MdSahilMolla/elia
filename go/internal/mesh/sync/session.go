package sync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"elia-go/internal/mesh/p2p"
	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
	"elia-go/internal/mesh/workspace"
)

// ChunkSize is how much of a file travels in one FILE_TRANSFER frame. It stays
// well under p2p.MaxFrameSize so a frame has room for its envelope.
const ChunkSize = 256 << 10 // 256 KiB

// HandshakeTimeout bounds pairing, so a silent peer cannot hang the CLI.
const HandshakeTimeout = 30 * time.Second

// SyncTimeout bounds the whole initial synchronisation.
const SyncTimeout = 10 * time.Minute

// PeerSide is which end of the connection a session is.
type PeerSide string

// The two sides of a session.
const (
	SideHost   PeerSide = "host"
	SideMember PeerSide = "member"
)

// HostSession serves one joining member: it authenticates the join code, sends
// the manifest, and streams the files the member is missing.
type HostSession struct {
	ws      *workspace.Workspace
	conn    *Conn
	events  EventSink
	limiter *p2p.Limiter
	// peerID is the authenticated member, set by the handshake. It names who the
	// host now agrees with, which the agreed-state rows record.
	peerID string
}

// PeerID is the authenticated member this session is serving.
func (s *HostSession) PeerID() string { return s.peerID }

// NewHostSession wraps an accepted connection in a host-side session.
func NewHostSession(ws *workspace.Workspace, conn *Conn, events EventSink, limiter *p2p.Limiter) *HostSession {
	if limiter == nil {
		limiter = p2p.NewLimiter()
	}
	return &HostSession{ws: ws, conn: conn, events: events, limiter: limiter}
}

// Conn exposes the underlying connection, for status reporting and shutdown.
func (s *HostSession) Conn() *Conn { return s.conn }

// AuthenticateHost runs the host half of the handshake. The member proves
// possession of the join secret; the host verifies the code is live, consumes
// one use of it, and pins the member's certificate.
func (s *HostSession) AuthenticateHost(ctx context.Context, code security.JoinCodePayload) (string, error) {
	if code.WorkspaceID != s.ws.ID {
		return "", fmt.Errorf("join code is for workspace %q, this is %q", code.WorkspaceID, s.ws.ID)
	}

	addr := s.conn.RemoteAddr()
	if !s.limiter.Allow(addr) {
		retry := s.limiter.RetryAfter(addr).Round(time.Second)
		return "", s.reject(CodeRateLimited, fmt.Errorf("too many failed attempts; retry in %s", retry))
	}

	var hello Hello
	if err := s.conn.ReceiveInto(TypeHello, &hello); err != nil {
		s.limiter.Fail(addr)
		return "", fmt.Errorf("receive HELLO: %w", err)
	}
	if hello.WorkspaceID != s.ws.ID {
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed,
			fmt.Errorf("HELLO names workspace %q, this is %q", hello.WorkspaceID, s.ws.ID))
	}
	if err := security.ValidatePeerID(hello.PeerID); err != nil {
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed, err)
	}
	if hello.Protocol != ProtocolVersion {
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed,
			fmt.Errorf("peer speaks protocol %d, this build speaks %d", hello.Protocol, ProtocolVersion))
	}

	hostNonce, err := NewNonce()
	if err != nil {
		return "", err
	}
	// The host's nonce travels in its HELLO, binding the auth transcript.
	if err := s.conn.Send(TypeHello, Hello{
		WorkspaceID: s.ws.ID,
		PeerID:      s.ws.PeerID,
		Role:        string(SideHost),
		Protocol:    ProtocolVersion,
		Nonce:       hostNonce,
		DisplayName: s.ws.Name,
	}); err != nil {
		return "", err
	}

	var auth Auth
	if err := s.conn.ReceiveInto(TypeAuth, &auth); err != nil {
		s.limiter.Fail(addr)
		return "", fmt.Errorf("receive AUTH: %w", err)
	}
	if !VerifyAuthProof(code.Secret, s.ws.ID, hostNonce, auth.Nonce, auth.Proof) {
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed, errors.New("join proof did not verify"))
	}

	// The code is now spent, and it happens before a single byte of workspace
	// content is sent. Redeem is a conditional update, so two peers racing on
	// a single-use code cannot both get in.
	if _, err := s.ws.Store.RedeemCode(code.HashCode(), time.Now()); err != nil {
		s.limiter.Fail(addr)
		return "", s.reject(codeErrorCode(err), err)
	}
	s.limiter.Success(addr)

	// Pin the member's certificate: from here it authenticates reconnects with
	// no join code at all.
	certHash := s.conn.RemoteCertSHA256()
	if certHash == "" {
		return "", errors.New("member presented no certificate")
	}
	now := time.Now().UTC()
	if err := s.ws.Store.AddPeer(store.PeerRow{
		PeerID:      hello.PeerID,
		Role:        store.RoleMember,
		CertSHA256:  certHash,
		DisplayName: hello.DisplayName,
		JoinedAt:    now,
		LastSeen:    now,
	}); err != nil {
		return "", fmt.Errorf("record member: %w", err)
	}

	if err := s.describeWorkspace(); err != nil {
		return "", err
	}
	s.events.Emit(EventConnected, "member %s authenticated", hello.PeerID)
	s.peerID = hello.PeerID
	return hello.PeerID, nil
}

// AuthenticateReconnect admits a member that has already paired. There is no
// join code and no shared secret on this path: the credential is the pinned
// certificate the peer already presented to the TLS layer, plus the nonces that
// keep the exchange from being replayed.
func (s *HostSession) AuthenticateReconnect(ctx context.Context) (string, error) {
	certHash := s.conn.RemoteCertSHA256()
	if certHash == "" {
		return "", errors.New("peer presented no certificate")
	}
	peer, err := s.ws.Store.PeerByCert(certHash)
	if err != nil {
		return "", fmt.Errorf("no pinned certificate matches this peer: %w", err)
	}

	addr := s.conn.RemoteAddr()
	if !s.limiter.Allow(addr) {
		retry := s.limiter.RetryAfter(addr).Round(time.Second)
		return "", s.reject(CodeRateLimited, fmt.Errorf("too many failed attempts; retry in %s", retry))
	}

	// The peer may open with RECONNECT, or a member that is mid-pairing opens
	// with HELLO. Either is acceptable; anything else is not.
	typ, payload, err := s.conn.Receive()
	if err != nil {
		s.limiter.Fail(addr)
		return "", fmt.Errorf("receive reconnect: %w", err)
	}
	var nonce string
	switch typ {
	case TypeReconnect:
		var rc Reconnect
		if err := json.Unmarshal(payload, &rc); err != nil {
			s.limiter.Fail(addr)
			return "", fmt.Errorf("%w: decode RECONNECT: %v", ErrProtocol, err)
		}
		if rc.WorkspaceID != s.ws.ID {
			s.limiter.Fail(addr)
			return "", s.reject(CodeAuthFailed,
				fmt.Errorf("RECONNECT names workspace %q, this is %q", rc.WorkspaceID, s.ws.ID))
		}
		if rc.PeerID != peer.PeerID {
			// A pinned certificate speaking for a different peer id is either
			// a bug or an attempt to borrow someone else's slot.
			s.limiter.Fail(addr)
			return "", s.reject(CodeAuthFailed,
				fmt.Errorf("certificate is pinned to peer %q but claims %q", peer.PeerID, rc.PeerID))
		}
		if rc.Protocol != ProtocolVersion {
			s.limiter.Fail(addr)
			return "", s.reject(CodeAuthFailed,
				fmt.Errorf("peer speaks protocol %d, this build speaks %d", rc.Protocol, ProtocolVersion))
		}
		nonce = rc.Nonce
	case TypeHello:
		// Tolerate a HELLO opener so a member that always sends one still
		// works; the pinned certificate already proved who it is.
		var hello Hello
		if err := json.Unmarshal(payload, &hello); err != nil {
			s.limiter.Fail(addr)
			return "", fmt.Errorf("%w: decode HELLO: %v", ErrProtocol, err)
		}
		if hello.WorkspaceID != s.ws.ID || hello.PeerID != peer.PeerID {
			s.limiter.Fail(addr)
			return "", s.reject(CodeAuthFailed, errors.New("HELLO does not match the pinned peer"))
		}
		nonce = hello.Nonce
	default:
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed, fmt.Errorf("%w: expected RECONNECT or HELLO, got %s", ErrProtocol, typ))
	}
	if nonce == "" {
		s.limiter.Fail(addr)
		return "", s.reject(CodeAuthFailed, errors.New("peer sent no nonce"))
	}

	hostNonce, err := NewNonce()
	if err != nil {
		return "", err
	}
	if err := s.conn.Send(TypeReconnect, Reconnect{
		WorkspaceID: s.ws.ID,
		PeerID:      s.ws.PeerID,
		Protocol:    ProtocolVersion,
		Nonce:       hostNonce,
	}); err != nil {
		return "", err
	}
	s.limiter.Success(addr)

	if err := s.ws.Store.TouchPeer(peer.PeerID); err != nil {
		return "", err
	}
	if err := s.describeWorkspace(); err != nil {
		return "", err
	}
	s.events.Emit(EventConnected, "member %s reconnected (no join code)", peer.PeerID)
	s.peerID = peer.PeerID
	return peer.PeerID, nil
}

func codeErrorCode(err error) string {
	switch {
	case errors.Is(err, store.ErrCodeExpired), errors.Is(err, store.ErrCodeExhausted), errors.Is(err, store.ErrNotFound):
		return CodeCodeInvalid
	default:
		return CodeInternal
	}
}

// reject sends an ERROR frame and returns the cause, so the peer learns why
// rather than seeing an unexplained disconnect.
func (s *HostSession) reject(code string, cause error) error {
	s.events.Emit(EventError, "%s", cause)
	s.conn.Send(TypeError, ErrorMsg{Code: code, Message: "request rejected"})
	return cause
}

// describeWorkspace sends the WORKSPACE_INFO frame that every session opens
// with, whether the member paired with a code or reconnected.
func (s *HostSession) describeWorkspace() error {
	manifest, _, err := s.ws.RefreshManifest()
	if err != nil {
		return err
	}
	return s.conn.Send(TypeWorkspaceInfo, WorkspaceInfo{
		WorkspaceID: s.ws.ID,
		Name:        s.ws.Name,
		FileCount:   len(manifest.Files),
		TotalSize:   manifest.TotalSize(),
		IgnoreRules: workspace.DefaultIgnoreRules,
	})
}

// ServeInitialSync answers the member's file request and streams the files.
func (s *HostSession) ServeInitialSync(ctx context.Context) error {
	s.events.Emit(EventSyncStart, "building manifest")

	manifest, skipped, err := s.ws.RefreshManifest()
	if err != nil {
		return err
	}
	for _, note := range skipped {
		s.events.Emit(EventInfo, "skipped %s", note)
	}
	if err := s.conn.Send(TypeManifest, Manifest{
		WorkspaceID: s.ws.ID,
		Files:       toProtocolEntries(manifest.Files),
	}); err != nil {
		return fmt.Errorf("send manifest: %w", err)
	}

	var req FileRequest
	if err := s.conn.ReceiveInto(TypeFileRequest, &req); err != nil {
		return fmt.Errorf("receive file request: %w", err)
	}
	if len(req.Paths) > maxRequestPaths {
		return s.reject(CodeTooLarge, fmt.Errorf("requested %d paths at once (limit %d)", len(req.Paths), maxRequestPaths))
	}
	if len(req.Preserve) > maxRequestPaths {
		return s.reject(CodeTooLarge, fmt.Errorf("requested %d preserved paths at once (limit %d)", len(req.Preserve), maxRequestPaths))
	}

	// Preserve requests are served from the same validated path as normal ones.
	// The member will not apply them, but the member is still untrusted, and the
	// content never reaches anywhere it was not already going.
	paths := append(append([]string{}, req.Paths...), req.Preserve...)

	sent := 0
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		// A request is untrusted input: re-validate before reading anything.
		if _, err := security.SecureJoin(s.ws.Root, path); err != nil {
			return s.reject(CodeBadPath, err)
		}
		entry, ok := manifest.Lookup(path)
		if !ok {
			// Not in the manifest, so not a file this workspace will serve.
			// Say so explicitly: staying silent would leave the member waiting
			// for a file that is never coming.
			return s.reject(CodeBadPath, fmt.Errorf("%q is not in the manifest", path))
		}
		if err := s.sendFile(entry); err != nil {
			return err
		}
		sent++
		s.events.Emit(EventSyncProgress, "sent %d/%d: %s", sent, len(paths), path)
	}
	if err := s.recordAgreement(manifest, req.Preserve); err != nil {
		return err
	}
	s.events.Emit(EventSyncComplete, "sent %d file(s)", sent)
	return nil
}

// recordAgreement writes the state both sides now share.
//
// Without this the host would hold no record of its own files, and every later
// change from a member would look like an edit to a file the host has never
// tracked, so it would be reported as a conflict instead of applied. The member
// records the same rows on its side; a file is only agreed once both sides say so.
//
// Paths the member asked to preserve are skipped: those are the files the two
// sides disagree about, and recording them as agreed would erase the evidence and
// make the next diff treat one of them as an ordinary update.
func (s *HostSession) recordAgreement(manifest *workspace.Manifest, preserve []string) error {
	skip := make(map[string]bool, len(preserve))
	for _, p := range preserve {
		skip[p] = true
	}
	writer := s.peerID
	if writer == "" {
		writer = "member"
	}
	rows := make([]store.FileRow, 0, len(manifest.Files))
	for _, f := range manifest.Files {
		if skip[f.Path] {
			continue
		}
		rows = append(rows, store.FileRow{
			Path:       f.Path,
			Size:       f.Size,
			SHA256:     f.Hash,
			Version:    f.Version,
			LastWriter: writer,
		})
	}
	if err := s.ws.Store.UpsertFiles(rows); err != nil {
		return fmt.Errorf("record the agreed state: %w", err)
	}
	return nil
}

// maxRequestPaths bounds one FILE_REQUEST.
const maxRequestPaths = 100000

func (s *HostSession) sendFile(entry workspace.FileEntry) error {
	abs, err := security.SecureJoin(s.ws.Root, entry.Path)
	if err != nil {
		return s.reject(CodeBadPath, err)
	}
	f, err := os.Open(abs)
	if err != nil {
		return fmt.Errorf("open %s: %w", entry.Path, err)
	}
	defer f.Close()

	buf := make([]byte, ChunkSize)
	var offset int64
	sentChunk := false
	for {
		n, readErr := f.Read(buf)
		// A read can return data and io.EOF together, so the last chunk is
		// whichever read hit EOF. That flag is what tells the member to stop
		// reading and expect FILE_COMPLETE.
		if n > 0 || readErr == io.EOF {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if err := s.conn.Send(TypeFileTransfer, FileTransfer{
				Path:   entry.Path,
				Offset: offset,
				Data:   chunk,
				Done:   readErr == io.EOF,
			}); err != nil {
				return err
			}
			offset += int64(n)
			sentChunk = true
		} else if readErr != nil {
			return fmt.Errorf("read %s: %w", entry.Path, readErr)
		}
		if readErr != nil {
			break
		}
	}
	// An empty file produces no data at all, so it still needs one terminating
	// chunk, otherwise the member waits for a body that never comes.
	if !sentChunk {
		if err := s.conn.Send(TypeFileTransfer, FileTransfer{
			Path: entry.Path,
			Done: true,
		}); err != nil {
			return err
		}
	}
	// Catching a mid-send change here means the member's hash check fails
	// cleanly, rather than a corrupt file landing in its workspace.
	if offset != entry.Size {
		return fmt.Errorf("%s changed size while being sent (%d vs %d)", entry.Path, offset, entry.Size)
	}
	return s.conn.Send(TypeFileComplete, FileComplete{
		Path:    entry.Path,
		Size:    offset,
		Hash:    entry.Hash,
		Version: entry.Version,
	})
}

// MemberSession joins a workspace: it authenticates with a join code and pulls
// the files it is missing.
type MemberSession struct {
	ws      *workspace.Workspace
	conn    *Conn
	events  EventSink
	hostPin string
	// policy decides what happens to a file both sides changed. It defaults to
	// preserving, and is only relaxed when the user passes an explicit force.
	policy workspace.ApplyPolicy
}

// NewMemberSession wraps a dialled connection in a member-side session.
func NewMemberSession(ws *workspace.Workspace, conn *Conn, events EventSink) *MemberSession {
	return &MemberSession{
		ws:      ws,
		conn:    conn,
		events:  events,
		hostPin: conn.RemoteCertSHA256(),
		policy:  workspace.DefaultApplyPolicy(),
	}
}

// SetPolicy changes how locally-conflicting files are treated. Calling it after
// the initial sync has no effect on that sync, which has already run.
func (s *MemberSession) SetPolicy(p workspace.ApplyPolicy) { s.policy = p }

// Policy reports the current apply policy.
func (s *MemberSession) Policy() workspace.ApplyPolicy { return s.policy }

// Conn exposes the underlying connection.
func (s *MemberSession) Conn() *Conn { return s.conn }

// expect receives the next frame and requires it to be of type want.
//
// A host that refuses a connection answers with ERROR instead of the expected
// frame. Surfacing that message matters: "expected HELLO, got ERROR" tells the
// user nothing, while "no valid join code is currently active" tells them
// exactly what to do.
func (s *MemberSession) expect(want MessageType) ([]byte, error) {
	typ, payload, err := s.conn.Receive()
	if err != nil {
		return nil, err
	}
	if typ == TypeError {
		var e ErrorMsg
		json.Unmarshal(payload, &e)
		if e.Message == "" {
			e.Message = "no reason given"
		}
		return nil, fmt.Errorf("host refused: %s (%s)", e.Message, e.Code)
	}
	if typ != want {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrProtocol, want, typ)
	}
	return payload, nil
}

// AuthenticateMember runs the member half of the handshake using a join code.
func (s *MemberSession) AuthenticateMember(ctx context.Context, code security.JoinCodePayload) (WorkspaceInfo, error) {
	if code.WorkspaceID != s.ws.ID {
		return WorkspaceInfo{}, fmt.Errorf("join code is for workspace %q, this is %q", code.WorkspaceID, s.ws.ID)
	}
	if code.Expired(time.Now()) {
		return WorkspaceInfo{}, fmt.Errorf("join code expired at %s", code.ExpiresAt.Format(time.RFC3339))
	}

	memberNonce, err := NewNonce()
	if err != nil {
		return WorkspaceInfo{}, err
	}
	if err := s.conn.Send(TypeHello, Hello{
		WorkspaceID: s.ws.ID,
		PeerID:      s.ws.PeerID,
		Role:        string(SideMember),
		Protocol:    ProtocolVersion,
		Nonce:       memberNonce,
		DisplayName: s.ws.Name,
	}); err != nil {
		return WorkspaceInfo{}, err
	}

	var hostHello Hello
	payload, err := s.expect(TypeHello)
	if err != nil {
		return WorkspaceInfo{}, fmt.Errorf("receive host HELLO: %w", err)
	}
	if err := json.Unmarshal(payload, &hostHello); err != nil {
		return WorkspaceInfo{}, fmt.Errorf("%w: decode HELLO: %v", ErrProtocol, err)
	}
	if hostHello.WorkspaceID != s.ws.ID {
		return WorkspaceInfo{}, fmt.Errorf("host answered for workspace %q, expected %q", hostHello.WorkspaceID, s.ws.ID)
	}
	if hostHello.Protocol != ProtocolVersion {
		return WorkspaceInfo{}, fmt.Errorf("host speaks protocol %d, this build speaks %d", hostHello.Protocol, ProtocolVersion)
	}

	proof := AuthProof(code.Secret, s.ws.ID, hostHello.Nonce, memberNonce)
	if err := s.conn.Send(TypeAuth, Auth{Proof: proof, Nonce: memberNonce}); err != nil {
		return WorkspaceInfo{}, err
	}

	// A rejection arrives as an ERROR frame; anything else is the success path.
	payload, err = s.expect(TypeWorkspaceInfo)
	if err != nil {
		return WorkspaceInfo{}, err
	}

	var info WorkspaceInfo
	if err := json.Unmarshal(payload, &info); err != nil {
		return WorkspaceInfo{}, fmt.Errorf("%w: decode WORKSPACE_INFO: %v", ErrProtocol, err)
	}

	// Record the host's fingerprint and address so a later run can reconnect
	// without a join code.
	if s.hostPin != "" {
		if err := s.ws.SetMeta(workspace.MetaHostCert, s.hostPin); err != nil {
			return WorkspaceInfo{}, fmt.Errorf("record host fingerprint: %w", err)
		}
	}
	if err := s.ws.SetMeta(workspace.MetaRemoteHost, code.Host); err != nil {
		return WorkspaceInfo{}, err
	}
	if err := s.ws.SetMeta(workspace.MetaRemotePort, fmt.Sprintf("%d", code.Port)); err != nil {
		return WorkspaceInfo{}, err
	}
	if err := s.ws.SetRole(workspace.RoleMember); err != nil {
		return WorkspaceInfo{}, err
	}

	s.events.Emit(EventConnected, "authenticated with host %s", hostHello.PeerID)
	return info, nil
}

// Reconnect re-establishes a session with a host this peer is already paired
// with, using the pinned host certificate and stored address instead of a join
// code. This is what lets a member come back after a restart.
func (s *MemberSession) Reconnect(ctx context.Context) (WorkspaceInfo, error) {
	memberNonce, err := NewNonce()
	if err != nil {
		return WorkspaceInfo{}, err
	}
	if err := s.conn.Send(TypeReconnect, Reconnect{
		WorkspaceID: s.ws.ID,
		PeerID:      s.ws.PeerID,
		Protocol:    ProtocolVersion,
		Nonce:       memberNonce,
	}); err != nil {
		return WorkspaceInfo{}, err
	}

	payload, err := s.expect(TypeReconnect)
	if err != nil {
		return WorkspaceInfo{}, fmt.Errorf("awaiting host RECONNECT: %w", err)
	}
	var hostRc Reconnect
	if err := json.Unmarshal(payload, &hostRc); err != nil {
		return WorkspaceInfo{}, fmt.Errorf("%w: decode RECONNECT: %v", ErrProtocol, err)
	}
	if hostRc.WorkspaceID != s.ws.ID {
		return WorkspaceInfo{}, fmt.Errorf("host answered for workspace %q, expected %q", hostRc.WorkspaceID, s.ws.ID)
	}
	if hostRc.Protocol != ProtocolVersion {
		return WorkspaceInfo{}, fmt.Errorf("host speaks protocol %d, this build speaks %d", hostRc.Protocol, ProtocolVersion)
	}
	if hostRc.Nonce == "" {
		return WorkspaceInfo{}, fmt.Errorf("%w: host sent no nonce", ErrProtocol)
	}

	// The host then describes the workspace, as in a first pairing.
	payload, err = s.expect(TypeWorkspaceInfo)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	var info WorkspaceInfo
	if err := json.Unmarshal(payload, &info); err != nil {
		return WorkspaceInfo{}, fmt.Errorf("%w: decode WORKSPACE_INFO: %v", ErrProtocol, err)
	}

	s.events.Emit(EventConnected, "reconnected to host %s without a join code", hostRc.PeerID)
	return info, nil
}

// JoinInitialSync pulls every file the host offers that is missing or stale
// locally, verifying each file's hash before committing it to disk.
func (s *MemberSession) JoinInitialSync(ctx context.Context) (*SyncReport, error) {
	report := &SyncReport{StartedAt: time.Now().UTC()}

	var manifest Manifest
	if err := s.conn.ReceiveInto(TypeManifest, &manifest); err != nil {
		return nil, fmt.Errorf("receive manifest: %w", err)
	}
	if manifest.WorkspaceID != s.ws.ID {
		return nil, fmt.Errorf("manifest is for workspace %q, expected %q", manifest.WorkspaceID, s.ws.ID)
	}
	report.ManifestFiles = len(manifest.Files)

	local, err := workspace.LocalEntries(s.ws.Root, s.ws.Ignore)
	if err != nil {
		return nil, fmt.Errorf("inspect local workspace: %w", err)
	}
	base, err := s.ws.TrackedEntries()
	if err != nil {
		return nil, err
	}
	result := workspace.Diff(toWorkspaceManifest(manifest), local, base)
	report.LocalOnly = result.LocalOnly
	report.Divergent = result.Divergent
	report.Stale = result.Stale

	// Divergent files are reported, not fetched. Overwriting them is how the
	// first three milestones lost work, and the plan forbids it: conflicting
	// data is preserved and the user decides.
	need := result.Needs(s.policy)
	report.Transferred = len(need)
	report.Skipped = len(manifest.Files) - len(need)
	if len(result.Divergent) > 0 && !s.policy.OverwriteDivergent {
		s.events.Emit(EventConflict, "%d file(s) changed on both sides and were left alone", len(result.Divergent))
		for i, p := range result.Divergent {
			if i >= 10 {
				s.events.Emit(EventConflict, "  ... and %d more", len(result.Divergent)-i)
				break
			}
			s.events.Emit(EventConflict, "  %s", p)
		}
	}
	s.events.Emit(EventSyncStart, "manifest has %d file(s), %d need transferring", len(manifest.Files), len(need))

	// Always send a request, even an empty one. It is the member's signal that
	// it has finished comparing; the host blocks on it, so omitting it when
	// there is nothing to fetch would deadlock an already-synchronised peer.
	//
	// Divergent paths go in Preserve rather than Paths: the member asks for the
	// content so nothing the host has is thrown away, but the bytes land in the
	// conflict directory and the member's own file is never touched.
	preserve := result.Divergent
	if s.policy.OverwriteDivergent {
		preserve = nil
		need = result.Needs(s.policy)
		report.Transferred = len(need)
		report.Skipped = len(manifest.Files) - len(need)
	}
	if err := s.conn.Send(TypeFileRequest, FileRequest{Paths: need, Preserve: preserve}); err != nil {
		return nil, fmt.Errorf("request files: %w", err)
	}

	received := 0
	for _, want := range need {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		got, err := s.receiveFile(manifest, "")
		if err != nil {
			return nil, err
		}
		if got != want {
			// Either a protocol bug or an attempt to smuggle a path; stop
			// rather than write something that was not requested.
			return nil, fmt.Errorf("host sent %q while %q was requested", got, want)
		}
		received++
		s.events.Emit(EventSyncProgress, "received %d/%d: %s", received, len(need), got)
	}

	// The preserved copies come last, in the order requested, and each is
	// recorded as a conflict so it can be found and resolved later.
	for _, path := range preserve {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		got, kept, err := s.receiveConflictCopy(manifest, path)
		if err != nil {
			return nil, err
		}
		if got != path {
			return nil, fmt.Errorf("host sent %q while %q was being preserved", got, path)
		}
		s.events.Emit(EventConflict, "%s differs on both sides; the host's version is at %s", path, kept)
		report.Conflicts = append(report.Conflicts, path)
	}

	// Record the host's versions, but only for files this peer is now clean on.
	// Marking a divergent file as agreed would erase the very evidence that it
	// diverged, and the next diff would treat the host's copy as an ordinary
	// update.
	divergent := make(map[string]bool, len(result.Divergent))
	for _, p := range result.Divergent {
		divergent[p] = true
	}
	rows := make([]store.FileRow, 0, len(manifest.Files))
	for _, f := range manifest.Files {
		if divergent[f.Path] {
			continue
		}
		rows = append(rows, store.FileRow{
			Path:       f.Path,
			Size:       f.Size,
			SHA256:     f.Hash,
			Version:    f.Version,
			LastWriter: "host",
		})
	}
	if err := s.ws.Store.UpsertFiles(rows); err != nil {
		return nil, fmt.Errorf("record manifest: %w", err)
	}

	report.FinishedAt = time.Now().UTC()
	s.events.Emit(EventSyncComplete, "synchronised %d file(s)", received)
	return report, nil
}

// receiveFile consumes FILE_TRANSFER frames for one file, applies it to the
// workspace, and returns the path that was written.
func (s *MemberSession) receiveFile(manifest Manifest, _ string) (string, error) {
	return s.streamTo(manifest, "")
}

// receiveConflictCopy fetches a file the member will not apply, writing it into
// the conflict directory and recording the divergence. The member's own copy is
// never touched: this is the "preserve and notify" half of conflict handling.
func (s *MemberSession) receiveConflictCopy(manifest Manifest, path string) (string, string, error) {
	// The destination is decided before the transfer starts, so the bytes land
	// in the conflict directory from the first chunk rather than being moved
	// there afterwards.
	kept := workspace.ConflictNameFor(path, "host", time.Now().UTC())
	got, err := s.streamTo(manifest, kept)
	if err != nil {
		return "", "", err
	}
	entry, _ := manifest.Lookup(path)
	if _, err := s.ws.Store.RecordConflict(store.ConflictRow{
		Path:          path,
		Kind:          store.ConflictBothEdited,
		LocalVersion:  s.localVersion(path),
		RemoteVersion: entry.Version,
		LocalHash:     s.localHash(path),
		RemoteHash:    entry.Hash,
		PeerID:        "host",
		KeptPath:      kept,
		DetectedAt:    time.Now().UTC(),
	}); err != nil {
		return "", "", fmt.Errorf("record conflict on %s: %w", path, err)
	}
	return got, kept, nil
}

func (s *MemberSession) localVersion(path string) int64 {
	row, err := s.ws.Store.GetFile(path)
	if err != nil {
		return 0
	}
	return row.Version
}

// localHash is the on-disk content, which is what makes a conflict two-sided:
// the store records what was last agreed, and the disk shows what the user
// actually has now.
func (s *MemberSession) localHash(path string) string {
	hash, err := workspace.HashAt(s.ws.Root, path, s.ws.Ignore)
	if err != nil {
		return ""
	}
	return hash
}

// streamTo receives one file's frames and commits them atomically, returning
// the workspace path the host claimed.
//
// dest is a workspace-relative path inside the conflict directory. When it is
// empty the file is applied to its real location. Framing and verification are
// identical either way, so a preserved copy holds exactly the bytes the host has
// rather than a re-derivation of them.
func (s *MemberSession) streamTo(manifest Manifest, dest string) (string, error) {
	typ, payload, err := s.conn.Receive()
	if err != nil {
		return "", fmt.Errorf("receive file: %w", err)
	}
	if typ == TypeError {
		var e ErrorMsg
		json.Unmarshal(payload, &e)
		return "", fmt.Errorf("host reported %s: %s", e.Code, e.Message)
	}
	if typ != TypeFileTransfer {
		return "", fmt.Errorf("%w: expected FILE_TRANSFER, got %s", ErrProtocol, typ)
	}

	var chunk FileTransfer
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return "", fmt.Errorf("%w: decode FILE_TRANSFER: %v", ErrProtocol, err)
	}
	path := chunk.Path
	entry, ok := manifest.Lookup(path)
	if !ok {
		return "", fmt.Errorf("host sent %q, which is not in the manifest", path)
	}

	// SecureJoin cannot be used here: it refuses a missing parent, and a
	// first join into an empty workspace has none. SecureMkdirAll builds the
	// chain under the same symlink rules.
	var abs string
	if dest == "" {
		abs, err = security.SecureMkdirAll(s.ws.Root, path)
	} else {
		abs, err = security.SecureMkdirAll(s.ws.Root, dest)
	}
	if err != nil {
		return "", err
	}
	// A dot prefix keeps the temp file out of the way of ordinary listings, and
	// the .part suffix is in the ignore list so a concurrent walk skips it.
	tmp, err := os.CreateTemp(filepath.Dir(abs), "."+filepath.Base(abs)+".part*")
	if err != nil {
		return "", fmt.Errorf("create temp file for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	// Any failure past this point removes the temp file; a half-written file is
	// never left in the workspace.
	defer os.Remove(tmpName)

	hasher := sha256.New()
	var written int64

	for {
		if chunk.Offset != written {
			tmp.Close()
			return "", fmt.Errorf("%s: chunk offset %d does not follow %d", path, chunk.Offset, written)
		}
		if written+int64(len(chunk.Data)) > security.MaxFileSize {
			tmp.Close()
			return "", fmt.Errorf("%s: %w", path, security.ErrTooLarge)
		}
		if _, err := tmp.Write(chunk.Data); err != nil {
			tmp.Close()
			return "", fmt.Errorf("write %s: %w", path, err)
		}
		hasher.Write(chunk.Data)
		written += int64(len(chunk.Data))

		if chunk.Done {
			break
		}
		typ, payload, err := s.conn.Receive()
		if err != nil {
			tmp.Close()
			return "", fmt.Errorf("receive chunk for %s: %w", path, err)
		}
		if typ == TypeError {
			var e ErrorMsg
			json.Unmarshal(payload, &e)
			tmp.Close()
			return "", fmt.Errorf("host reported %s while sending %s: %s", e.Code, path, e.Message)
		}
		if typ != TypeFileTransfer {
			tmp.Close()
			return "", fmt.Errorf("%w: expected FILE_TRANSFER, got %s", ErrProtocol, typ)
		}
		var next FileTransfer
		if err := json.Unmarshal(payload, &next); err != nil {
			tmp.Close()
			return "", err
		}
		if next.Path != path {
			tmp.Close()
			return "", fmt.Errorf("host switched from %s to %s mid-file", path, next.Path)
		}
		chunk = next
	}

	typ, payload, err = s.conn.Receive()
	if err != nil {
		tmp.Close()
		return "", fmt.Errorf("awaiting completion of %s: %w", path, err)
	}
	if typ == TypeError {
		var e ErrorMsg
		json.Unmarshal(payload, &e)
		tmp.Close()
		return "", fmt.Errorf("host reported %s: %s", e.Code, e.Message)
	}
	if typ != TypeFileComplete {
		tmp.Close()
		return "", fmt.Errorf("%w: expected FILE_COMPLETE, got %s", ErrProtocol, typ)
	}
	var done FileComplete
	if err := json.Unmarshal(payload, &done); err != nil {
		tmp.Close()
		return "", err
	}
	if done.Path != path {
		tmp.Close()
		return "", fmt.Errorf("host completed %q while sending %q", done.Path, path)
	}
	if written != entry.Size || written != done.Size {
		tmp.Close()
		return "", fmt.Errorf("%s: received %d bytes, expected %d", path, written, entry.Size)
	}
	// The per-file cap passed long ago; this is the workspace-wide one. It is
	// checked before the commit so a refused file leaves nothing behind, and it
	// nets off the copy being replaced so a legitimate rewrite of a large file
	// is not mistaken for growth. A preserved copy is a new file, so it is
	// checked additively against the same cap.
	if dest == "" {
		err = s.ws.CheckReplace(abs, written)
	} else {
		err = s.ws.CheckGrowth(written)
	}
	if err != nil {
		tmp.Close()
		return "", err
	}
	gotHash := hex.EncodeToString(hasher.Sum(nil))
	if gotHash != entry.Hash || gotHash != done.Hash {
		tmp.Close()
		return "", fmt.Errorf("%s: %s (got %s, expected %s)", path, CodeHashMismatch, gotHash, entry.Hash)
	}

	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", fmt.Errorf("sync %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close %s: %w", path, err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return "", fmt.Errorf("chmod %s: %w", path, err)
	}
	if err := os.Rename(tmpName, abs); err != nil {
		return "", fmt.Errorf("commit %s: %w", path, err)
	}
	return path, nil
}

// SyncReport summarises an initial synchronisation.
type SyncReport struct {
	StartedAt     time.Time
	FinishedAt    time.Time
	ManifestFiles int
	Transferred   int
	Skipped       int
	LocalOnly     []string
	// Stale were replaced: the remote had moved on and the local copy was
	// untouched since the last agreement.
	Stale []string
	// Divergent changed on both sides. They are never written without an
	// explicit force, so a non-empty list here means work was not synced.
	Divergent []string
	// Conflicts lists paths whose remote version was preserved rather than
	// applied, with the copy already on disk.
	Conflicts []string
}

// Duration reports how long the synchronisation took.
func (r *SyncReport) Duration() time.Duration {
	if r.FinishedAt.IsZero() {
		return 0
	}
	return r.FinishedAt.Sub(r.StartedAt)
}

// toWorkspaceManifest adapts a protocol manifest to the workspace type, so the
// diff logic is shared rather than duplicated across the wire boundary.
func toWorkspaceManifest(m Manifest) *workspace.Manifest {
	out := &workspace.Manifest{WorkspaceID: m.WorkspaceID}
	for _, f := range m.Files {
		out.Files = append(out.Files, workspace.FileEntry{
			Path: f.Path, Size: f.Size, Hash: f.Hash, Version: f.Version,
		})
	}
	return out
}

func toProtocolEntries(files []workspace.FileEntry) []FileEntry {
	out := make([]FileEntry, 0, len(files))
	for _, f := range files {
		out = append(out, FileEntry{Path: f.Path, Size: f.Size, Hash: f.Hash, Version: f.Version})
	}
	return out
}
