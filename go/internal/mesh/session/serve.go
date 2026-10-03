// Package session wires the workspace, p2p and sync layers into the two
// long-lived roles: hosting a workspace, and joining one.
package session

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	stdsync "sync"
	"time"

	"elia-go/internal/mesh/engine"
	"elia-go/internal/mesh/p2p"
	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// ErrNoActiveCode means a peer tried to pair but no join code is live.
var ErrNoActiveCode = errors.New("no active join code")

// ErrControlNotReady means a control frame was offered before the live engine
// existed to carry it. It is reported rather than swallowed, because dropping it
// silently would look like a working relay that quietly sends nothing.
var ErrControlNotReady = errors.New("control relay is not attached yet")

// Control is a supervisor's opaque channel to the peer.
//
// It is created by the caller, handed to the session as part of its options,
// and returned holding a send function once the live engine is running. The
// session calls Receive for every frame the peer relays; the caller pushes its
// own frames with SendControl.
//
// Splitting it this way keeps one object as the single meeting point for both
// directions, which is what stops the two from drifting out of step: a caller
// cannot end up writing into an engine that is no longer the one attached.
type Control struct {
	// Receive receives frames relayed from the peer. Nil discards them.
	Receive sync.ControlObserver

	mu   stdsync.Mutex
	send func(json.RawMessage) (int, error)
}

// SendControl relays one frame to the attached peer, reporting how many peers
// it reached. It fails with ErrControlNotReady before the engine is running,
// which is the window between pairing and the first peer being attached.
func (c *Control) SendControl(payload json.RawMessage) (int, error) {
	if c == nil {
		return 0, ErrControlNotReady
	}
	c.mu.Lock()
	send := c.send
	c.mu.Unlock()
	if send == nil {
		return 0, ErrControlNotReady
	}
	return send(payload)
}

// bind installs the engine's send side.
func (c *Control) bind(send func(json.RawMessage) (int, error)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.send = send
	c.mu.Unlock()
}

// BindForTest installs a send function from another package.
//
// The CLI's relay tests need to drive forwarding without a live p2p link, and the
// unexported bind is deliberately not reachable from there. It is named for what
// it is rather than left off so a caller in another package cannot use it by
// accident.
func (c *Control) BindForTest(send func(json.RawMessage) (int, error)) {
	c.bind(send)
}

// Observe makes Control usable directly as a sync.ControlObserver, so the
// engine can be wired to it without an adapter in every caller.
func (c *Control) Observe(frame sync.Control) {
	if c == nil || c.Receive == nil {
		return
	}
	c.Receive(frame)
}

// codeSweepInterval is how often expired join codes are deleted. Codes are short
// lived, so this only has to be frequent enough that the table stays small.
const codeSweepInterval = 5 * time.Minute

// codeIssuer mints join codes and hands them to the operator.
//
// A join code is a one-time capability, so a host that has just spent its only one
// cannot invite anybody else. Issuing a replacement keeps the security property
// while still letting a workspace be shared with more than one person: the operator
// reads the new code off the terminal. Making the code multi-use instead would be
// simpler and would remove the property entirely.
type codeIssuer struct {
	mint        func() (security.JoinCodePayload, string, error)
	onCode      func(security.JoinCodePayload, string)
	events      sync.EventSink
	workspaceID string
}

// issue prints a code, if a handler is attached.
func (i codeIssuer) issue(payload security.JoinCodePayload, formatted string) {
	if i.onCode != nil {
		i.onCode(payload, formatted)
	}
}

// replenish mints and prints a new code when none is live. It is called after a
// pairing has consumed the last one.
func (i codeIssuer) replenish(vault *codeVault) {
	if _, err := vault.find(i.workspaceID, time.Now()); err == nil {
		return
	}
	payload, formatted, err := i.mint()
	if err != nil {
		i.events.Emit(sync.EventError, "mint a replacement join code: %v", err)
		return
	}
	i.issue(payload, formatted)
}

// ServeOptions configures a hosting session.
type ServeOptions struct {
	// ListenAddr is the address to bind, for example 127.0.0.1:0.
	ListenAddr string
	// JoinHost is the address a join code advertises. It may differ from the
	// bind address: a host reachable from another machine usually binds
	// 0.0.0.0 but must advertise its LAN IP.
	JoinHost string
	// CodeTTL bounds the lifetime of the join code minted on startup.
	CodeTTL time.Duration
	// OnEvent receives session events for the CLI to print.
	OnEvent func(sync.Event)
	// OnCode is called once, with the join code to print.
	OnCode func(code security.JoinCodePayload, formatted string)
	// OnChange receives a structured event for every file change, whether made
	// here or applied from a peer. Nil discards them.
	//
	// This sits alongside OnEvent because OnEvent carries prose meant for a
	// terminal, while a program such as Elia needs the path, operation and hashes
	// as data. OnEvent alone would leave a consumer parsing English.
	OnChange func(sync.ChangeEvent)
	// Controls is the supervisor's opaque channel to the peer. Nil disables
	// relaying entirely: the live engine still runs, and frames a peer might send
	// are discarded rather than being an error for a consumer that does not speak
	// the protocol.
	Controls *Control
	// OnReady is called once the listener is bound and the sync engine is
	// running, with the address that was actually bound.
	//
	// Serve does not return until the session ends, so without this a caller has
	// no way to learn that the host is accepting peers. The join code is not a
	// substitute: a caller that does not print one to a terminal never sees it.
	OnReady func(*ServeResult)
	// Live keeps each connected peer attached after its initial synchronisation,
	// so changes made afterwards are sent in both directions.
	//
	// It is off by default because a live session is concurrent and lasts as
	// long as its peers: a caller that only wants one transfer, or that manages
	// several peers itself, must not have its connection held open by default.
	Live bool
}

// ServeResult reports what a hosting session bound.
type ServeResult struct {
	// BoundAddr is the address actually listening, resolved after bind. When
	// the port was 0, this is where the OS assigned one.
	BoundAddr string
	// JoinPort is the port a join code uses, which follows the bind.
	JoinPort int
	// JoinHost is the address advertised in the join code.
	JoinHost string
}

// normalizeListenAddr accepts the forms a person actually types: a bare port
// ("8080"), a bare host ("0.0.0.0"), a host and port ("127.0.0.1:8080"), or an
// empty string for the loopback default. Requiring "host:port" here would make
// the common case of binding all interfaces on any free port fail on a
// technicality.
func normalizeListenAddr(addr string) (string, error) {
	if addr == "" {
		return "127.0.0.1:0", nil
	}
	// All digits: a bare port.
	if _, err := strconv.Atoi(addr); err == nil {
		return net.JoinHostPort("127.0.0.1", addr), nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		// No port present: treat the whole value as the host and take any port.
		if strings.Contains(err.Error(), "missing port") {
			return net.JoinHostPort(addr, "0"), nil
		}
		return "", fmt.Errorf("invalid listen address %q: %w", addr, err)
	}
	if host == "" {
		return "", fmt.Errorf("invalid listen address %q: no host", addr)
	}
	if port == "" {
		port = "0"
	}
	return net.JoinHostPort(host, port), nil
}

// codeVault keeps the live join codes' secrets in memory.
//
// Only digests are persisted, which is right for the database but leaves the
// host unable to verify a proof it does not have the secret for. The secrets
// therefore live here for as long as the process does: they are never written
// to disk, and a restart retires the codes minted before it.
type codeVault struct {
	mu    stdsync.Mutex
	codes map[string]security.JoinCodePayload
}

func newCodeVault() *codeVault {
	return &codeVault{codes: make(map[string]security.JoinCodePayload)}
}

func (v *codeVault) put(p security.JoinCodePayload) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.codes[p.HashCode()] = p
}

// find returns a live code for a workspace without removing it.
//
// Peek and consume are deliberately separate. An earlier version removed the
// code on lookup, which meant any client that could complete a TLS handshake
// could burn a code by connecting and then failing the proof, locking the real
// peer out until the host restarted. The code is now only spent once a proof
// has actually verified.
func (v *codeVault) find(workspaceID string, now time.Time) (security.JoinCodePayload, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	for hash, p := range v.codes {
		if p.WorkspaceID != workspaceID {
			continue
		}
		if p.Expired(now) {
			delete(v.codes, hash)
			continue
		}
		return p, nil
	}
	return security.JoinCodePayload{}, ErrNoActiveCode
}

// consume removes a code that has just been redeemed, by its digest.
func (v *codeVault) consume(codeSHA256 string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.codes, codeSHA256)
}

// Serve hosts a workspace. It mints a join code, then accepts peers until the
// context is cancelled. Peers are handled one at a time in this pass, which is
// enough to prove the design before concurrent sessions are needed.
func Serve(ctx context.Context, ws *workspace.Workspace, opts ServeOptions) (*ServeResult, error) {
	if opts.ListenAddr == "" {
		opts.ListenAddr = "127.0.0.1:0"
	}
	if opts.CodeTTL <= 0 {
		opts.CodeTTL = security.JoinCodeTTL
	}
	listenAddr, err := normalizeListenAddr(opts.ListenAddr)
	if err != nil {
		return nil, err
	}
	events := sync.EventSink(opts.OnEvent)

	identity, err := ws.Identity()
	if err != nil {
		return nil, err
	}

	listener, err := p2p.Listen(listenAddr, identity)
	if err != nil {
		return nil, err
	}
	defer listener.Close()

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return nil, fmt.Errorf("listener bound a %T, want a TCP address", listener.Addr())
	}

	// A bind of 0.0.0.0 is not an address a peer can dial, so resolve it to
	// something routable before it goes into the code.
	joinHost := opts.JoinHost
	if joinHost == "" {
		joinHost = defaultAdvertiseHost(tcpAddr.IP)
	}

	vault := newCodeVault()
	issuer := codeIssuer{events: events, workspaceID: ws.ID}
	mint := func() (security.JoinCodePayload, string, error) {
		_, payload, err := security.NewJoinCode(ws.ID, joinHost, tcpAddr.Port,
			identity.ShortFingerprint(), opts.CodeTTL)
		if err != nil {
			return security.JoinCodePayload{}, "", err
		}
		formatted := security.FormatJoinCode(payload)
		vault.put(payload)
		// Only the digest is persisted, so a leaked database hands out no live
		// code, and the row is what survives a restart to tell an operator a code
		// was once issued.
		if _, err := ws.Store.AddCode(payload.HashCode(), payload.ExpiresAt, 1); err != nil {
			return security.JoinCodePayload{}, "", fmt.Errorf("record join code: %w", err)
		}
		return payload, formatted, nil
	}
	issuer.mint = mint
	issuer.onCode = opts.OnCode

	payload, formatted, err := mint()
	if err != nil {
		return nil, err
	}

	if err := ws.SetMeta(workspace.MetaJoinHost, joinHost); err != nil {
		return nil, err
	}
	if err := ws.SetMeta(workspace.MetaJoinPort, fmt.Sprintf("%d", tcpAddr.Port)); err != nil {
		return nil, err
	}

	result := &ServeResult{BoundAddr: tcpAddr.String(), JoinPort: tcpAddr.Port, JoinHost: joinHost}
	events.Emit(sync.EventInfo, "listening on %s, advertising %s",
		tcpAddr.String(), net.JoinHostPort(joinHost, fmt.Sprint(tcpAddr.Port)))
	issuer.issue(payload, formatted)

	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	limiter := p2p.NewLimiter()

	// Codes are only consulted in memory while a host is running, so a long-lived
	// one needs to sweep the expired ones out of the database itself. Without this
	// a host that stays up for a week accumulates every code it ever minted, and
	// the table becomes a list of secrets that are all expired but still on disk.
	codeSweeper := time.NewTicker(codeSweepInterval)
	defer codeSweeper.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-codeSweeper.C:
				if _, err := ws.Store.ExpireCodes(time.Now()); err != nil {
					events.Emit(sync.EventError, "expire join codes: %v", err)
				}
			}
		}
	}()

	// The engine is what keeps a paired peer in step after the first transfer.
	// It is created here, once per hosting session, so every attached peer shares
	// one watcher, one heartbeat schedule and one suppression set. Per-peer
	// engines would each see the same local edit and send it several times.
	var live *engine.Engine
	if opts.Live {
		live, err = engine.New(engine.Config{
			Workspace: ws,
			Mode:      engine.ModeHost,
			Events:    events,
			Changes:   sync.ChangeObserver(opts.OnChange),
			// A nil Control is a nil method value, so the observer below is
			// non-nil but does nothing: no adapter needed for the common case
			// of a consumer that has no control protocol.
			Controls: opts.Controls.Observe,
		})
		if err != nil {
			return nil, fmt.Errorf("start the sync engine: %w", err)
		}
		if err := live.Run(ctx); err != nil {
			return nil, fmt.Errorf("start the sync engine: %w", err)
		}
		defer live.Close()
		// The send side exists only now. A supervisor that writes to stdin
		// before this point is told the relay is not attached, rather than
		// having its frame dropped without explanation.
		opts.Controls.bind(live.SendControl)
	}

	// Announced only now, with the listener bound and the engine watching. A
	// caller told "ready" any earlier could make an edit in the gap where the
	// watcher is not yet running, and it would be lost until something else
	// touched the file.
	if opts.OnReady != nil {
		opts.OnReady(result)
	}

	for {
		conn, cert, err := listener.Accept(ctx)
		if err != nil {
			if ctx.Err() != nil {
				events.Emit(sync.EventDisconnected, "shutting down")
				return result, nil
			}
			// A failed handshake is routine: port scanners and stray clients
			// both land here. Report it and keep serving.
			events.Emit(sync.EventError, "rejected a connection: %v", err)
			continue
		}

		events.Emit(sync.EventConnected, "%s connected", conn.RemoteAddr())

		// With the engine running, a peer stays connected for as long as it is
		// present, so each one needs its own goroutine. Handling them in the
		// accept loop would make the second peer wait for the first to leave,
		// which is the same as not allowing a second peer at all.
		if live != nil {
			go servePeerLive(ctx, live, ws, conn, cert, vault, limiter, events, issuer)
			continue
		}

		peerID, err := handlePeer(ctx, ws, conn, cert, vault, limiter, events, nil, issuer)
		if err != nil {
			events.Emit(sync.EventError, "%s: %v", conn.RemoteAddr(), err)
		} else {
			events.Emit(sync.EventDisconnected, "peer %s disconnected", peerID)
		}
		conn.Close()
	}
}

// servePeerLive runs one peer's whole attached lifetime: authenticate, transfer
// what is missing, then hand the connection to the engine and wait until the peer
// leaves or the session stops.
func servePeerLive(
	ctx context.Context,
	live *engine.Engine,
	ws *workspace.Workspace,
	conn *p2p.Conn,
	cert *x509.Certificate,
	vault *codeVault,
	limiter *p2p.Limiter,
	events sync.EventSink,
	issuer codeIssuer,
) {
	peerID, err := handlePeer(ctx, ws, conn, cert, vault, limiter, events, live, issuer)
	if err != nil {
		events.Emit(sync.EventError, "%s: %v", conn.RemoteAddr(), err)
		conn.Close()
		return
	}
	events.Emit(sync.EventInfo, "peer %s is now live", peerID)
}

// handlePeer admits one connection, either as a known member whose certificate
// is already pinned, or as a new pairer redeeming a live join code.
func handlePeer(
	ctx context.Context,
	ws *workspace.Workspace,
	conn *p2p.Conn,
	cert *x509.Certificate,
	vault *codeVault,
	limiter *p2p.Limiter,
	events sync.EventSink,
	live *engine.Engine,
	issuer codeIssuer,
) (string, error) {
	sess := sync.NewHostSession(ws, sync.NewConn(conn), events, limiter)

	// A member that reconnects presents the same pinned certificate and needs
	// no join code. This is the "join code is a pairing capability, not an
	// identity" rule in action: the code is spent once, and the pinned
	// certificate carries every session after that.
	if peer, err := ws.Store.PeerByCert(p2p.CertFingerprintHex(cert)); err == nil {
		events.Emit(sync.EventInfo, "peer %s recognised by pinned certificate", peer.PeerID)
		peerID, err := sess.AuthenticateReconnect(ctx)
		if err != nil {
			return "", err
		}
		// A reconnect spends no code, but the host may still be sitting on an
		// expired one, so the operator gets a fresh one either way.
		issuer.replenish(vault)
		syncCtx, cancel := syncContext(ctx)
		defer cancel()
		return finishPeer(ctx, peerID, ws, conn, sess, syncCtx, live, events)
	}

	// A new pairer must redeem a live code, which is looked up but not yet
	// spent: the secret is only consumed once the proof verifies, so a client
	// that connects and fails cannot lock the real peer out.
	code, err := vault.find(ws.ID, time.Now())
	if err != nil {
		events.Emit(sync.EventError, "no live join code for %s", conn.RemoteAddr())
		sync.NewConn(conn).Send(sync.TypeError, sync.ErrorMsg{
			Code:    sync.CodeCodeInvalid,
			Message: "no valid join code is currently active",
		})
		return "", err
	}
	events.Emit(sync.EventInfo, "redeeming a join code for %s", conn.RemoteAddr())

	peerID, err := sess.AuthenticateHost(ctx, code)
	if err != nil {
		return "", err
	}
	// The code is spent only now, and only once it is actually exhausted. A
	// multi-use code stays available; the database's conditional update remains
	// the authority on how many times it may be used.
	if rec, err := ws.Store.CodeByHash(code.HashCode()); err == nil && rec.Uses >= rec.MaxUses {
		vault.consume(code.HashCode())
	}
	// The pairing has happened, so a code that was good for one use is now spent.
	// Issue the next one immediately rather than leaving the operator to discover
	// they cannot invite anyone until a stranger tries and fails.
	issuer.replenish(vault)
	syncCtx, cancel := syncContext(ctx)
	defer cancel()
	return finishPeer(ctx, peerID, ws, conn, sess, syncCtx, live, events)
}

// finishPeer runs the initial synchronisation and then, when an engine is
// supplied, keeps the connection open for live updates.
func finishPeer(
	ctx context.Context,
	peerID string,
	ws *workspace.Workspace,
	conn *p2p.Conn,
	sess *sync.HostSession,
	syncCtx context.Context,
	live *engine.Engine,
	events sync.EventSink,
) (string, error) {
	if err := sess.ServeInitialSync(syncCtx); err != nil {
		return peerID, err
	}
	if live == nil {
		return peerID, nil
	}
	if err := live.Attach(peerID, sync.NewConn(conn)); err != nil {
		return peerID, err
	}
	if err := live.WaitPeer(ctx, peerID); err != nil && ctx.Err() == nil {
		events.Emit(sync.EventError, "peer %s: %v", peerID, err)
	}
	return peerID, nil
}

// syncContext bounds one initial synchronisation so a stalled peer cannot hold a
// session slot forever.
func syncContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, sync.SyncTimeout)
}

// JoinOptions configures a joining session.
type JoinOptions struct {
	// Code is the join code or p2pws:// URL, as typed or pasted. It is
	// required for a first pairing and ignored for a reconnect.
	Code string
	// ForcePairing demands a join code even when a pinned host is known.
	ForcePairing bool
	// OnEvent receives session events for the CLI to print.
	OnEvent func(sync.Event)
	// Live keeps the link open after the initial synchronisation so later edits
	// travel in both directions. Join then returns only when the host goes away
	// or the context is cancelled.
	//
	// It is off by default: a caller that wants one transfer, or that closes the
	// workspace immediately afterwards, should not be left holding a socket.
	Live bool
	// OnReady is called with the opened workspace and the initial report before a
	// live Join blocks. A live Join does not return until the link ends, so this
	// is how a caller learns the initial synchronisation is finished and what it
	// transferred.
	//
	// The workspace is passed because a first join into an empty folder creates
	// it: a caller that opened the folder beforehand has nothing to open, and one
	// that needs the workspace id or fingerprint has no other way to reach them
	// until the long-lived call returns.
	OnReady func(*workspace.Workspace, *sync.SyncReport)
	// OnChange receives a structured event for every file change, whether made
	// here or applied from the host. Nil discards them.
	//
	// As with ServeOptions.OnChange, this is the machine-readable counterpart to
	// OnEvent: a consumer needing the path, operation and hashes must not have to
	// parse the formatted progress messages.
	OnChange func(sync.ChangeEvent)
	// Controls is the supervisor's opaque channel to the host, as in
	// ServeOptions.Controls.
	Controls *Control
}

// Join pairs with a host and runs the initial synchronisation.
//
// The workspace at root may be new or existing. A brand-new folder adopts the
// workspace id named by the join code, because the id identifies the
// *workspace*, not the local copy of it: both peers must agree on it for
// manifests and versions to line up.
//
// A folder that has already paired reconnects with its pinned host certificate
// and needs no code. Pass ForcePairing to redeem a code anyway, which is how a
// rotated host identity is adopted.
func Join(ctx context.Context, root string, opts JoinOptions) (*workspace.Workspace, *sync.SyncReport, error) {
	return JoinWithPolicy(ctx, root, opts, workspace.DefaultApplyPolicy(), opts.OnEvent)
}

// JoinWithPolicy is Join with an explicit apply policy, so the CLI can offer a
// destructive overwrite only when the user asked for one.
//
// The policy is separate from JoinOptions on purpose: a caller must be able to
// request a force without also being able to set it by accident from a flag
// default, and the default here is always the preserving one.
func JoinWithPolicy(
	ctx context.Context,
	root string,
	opts JoinOptions,
	policy workspace.ApplyPolicy,
	onEvent func(sync.Event),
) (*workspace.Workspace, *sync.SyncReport, error) {
	events := sync.EventSink(onEvent)

	code, codeErr := security.ParseJoinCode(opts.Code)
	if codeErr == nil {
		if err := security.ValidateWorkspaceID(code.WorkspaceID); err != nil {
			return nil, nil, err
		}
	} else if opts.Code == "" && !workspace.Exists(root) {
		// No code and no folder to reconnect from: say the actionable thing
		// rather than complaining that the empty code failed to parse.
		return nil, nil, errors.New("this folder is not yet a workspace: run 'workspace create', or pass a join code")
	} else if opts.ForcePairing || !workspace.Exists(root) {
		// On a fresh folder there is nothing to reconnect to, so a bad code is
		// the whole request and must be reported. On an existing folder a
		// malformed code is noise: the pinned host is the better credential.
		return nil, nil, codeErr
	}

	// A new folder adopts the host's workspace id, so resolve the code first and
	// only create once there is something valid to create from.
	var (
		ws  *workspace.Workspace
		err error
	)
	if workspace.Exists(root) {
		if ws, err = workspace.Open(root); err != nil {
			return nil, nil, err
		}
	} else {
		if codeErr != nil {
			return nil, nil, errors.New("no join code given, and this folder is not yet a workspace")
		}
		if ws, err = workspace.Create(root, workspace.CreateOptions{AdoptWorkspaceID: code.WorkspaceID}); err != nil {
			return nil, nil, err
		}
	}
	closeOnError := func(err error) (*workspace.Workspace, *sync.SyncReport, error) {
		ws.Close()
		return nil, nil, err
	}

	// Decide the path: a pinned, reachable host means reconnect, and any code
	// given alongside it must at least agree about which workspace this is.
	target, reconnect := pinnedHost(ws)
	if !reconnect && codeErr != nil {
		return closeOnError(errors.New("no join code given, and this folder has no pinned host to reconnect to"))
	}
	if codeErr == nil && code.WorkspaceID != ws.ID {
		return closeOnError(fmt.Errorf("this folder belongs to workspace %q, but the code is for %q", ws.ID, code.WorkspaceID))
	}
	// ForcePairing means "use this code", so it has to actually change the
	// decision. Previously it was accepted and then ignored, and a caller
	// rotating a host identity would silently reconnect to the old one.
	if opts.ForcePairing && codeErr == nil {
		reconnect = false
	}
	if !reconnect {
		// A first pairing takes its address and pin from the code.
		target = hostTarget{address: code.Address(), pin: code.ServerFingerprint}
	}

	identity, err := ws.Identity()
	if err != nil {
		return closeOnError(err)
	}

	handshakeCtx, cancelHandshake := context.WithTimeout(ctx, sync.HandshakeTimeout)
	defer cancelHandshake()

	// The pin comes from the code on a first pairing, and from the stored host
	// fingerprint on a reconnect. Either way the handshake is authenticated
	// rather than trust-on-first-use: an impostor on that address is rejected.
	rawConn, err := p2p.DialPinned(handshakeCtx, target.address, identity, target.pin)
	if err != nil {
		return closeOnError(fmt.Errorf("connect to %s: %w", target.address, err))
	}
	// A live session hands the socket to the engine, which owns it from then on
	// and closes it when the link ends. Closing it here as well would sever a
	// connection that is meant to stay up.
	conn := sync.NewConn(rawConn)
	if !opts.Live {
		defer rawConn.Close()
	}
	events.Emit(sync.EventInfo, "connected to %s", target.address)

	sess := sync.NewMemberSession(ws, conn, events)
	sess.SetPolicy(policy)

	var info sync.WorkspaceInfo
	if reconnect {
		events.Emit(sync.EventInfo, "reconnecting to the pinned host, no join code needed")
		info, err = sess.Reconnect(handshakeCtx)
	} else {
		if code.Expired(time.Now()) {
			return closeOnError(fmt.Errorf("join code expired at %s", code.ExpiresAt.Format(time.RFC3339)))
		}
		info, err = sess.AuthenticateMember(handshakeCtx, code)
	}
	if err != nil {
		return closeOnError(err)
	}
	events.Emit(sync.EventInfo, "host %q offers %d file(s), %d bytes", info.Name, info.FileCount, info.TotalSize)

	syncCtx, cancelSync := context.WithTimeout(ctx, sync.SyncTimeout)
	defer cancelSync()

	report, err := sess.JoinInitialSync(syncCtx)
	if err != nil {
		return closeOnError(err)
	}
	events.Emit(sync.EventInfo, "initial synchronisation complete in %s", report.Duration().Round(time.Millisecond))
	if !opts.Live {
		if opts.OnReady != nil {
			opts.OnReady(ws, report)
		}
		return ws, report, nil
	}
	// A member links to the host under the host's own identity, so a reconnect
	// lands on the same entry and keeps that link's baseline cache.
	peerID := hostPeerID(ws)
	live, err := engine.New(engine.Config{
		Workspace: ws,
		Mode:      engine.ModeMember,
		Events:    events,
		Changes:   sync.ChangeObserver(opts.OnChange),
		Controls:  opts.Controls.Observe,
	})
	if err != nil {
		return closeOnError(fmt.Errorf("start the sync engine: %w", err))
	}
	if err := live.Run(ctx); err != nil {
		live.Close()
		return closeOnError(fmt.Errorf("start the sync engine: %w", err))
	}
	if err := live.Attach(peerID, conn); err != nil {
		live.Close()
		return closeOnError(fmt.Errorf("attach to the host: %w", err))
	}
	// Bound only after the peer is attached. Binding earlier would make
	// SendControl report success against a link that is not there yet, which is
	// worse than saying the relay is not attached.
	opts.Controls.bind(live.SendControl)
	// OnReady is called only now, once the link is attached and the watcher is
	// running. Announcing readiness before that would invite a caller to make a
	// change in the gap, where there is nothing to observe it and it is silently
	// lost until something else touches the file.
	if opts.OnReady != nil {
		opts.OnReady(ws, report)
	}
	return ws, report, stayLive(ctx, live, peerID, events)
}

// hostPeerID names the host in the link table. A member has exactly one peer, the
// host, and pinning it to the host's stored fingerprint means a reconnect reuses
// the same entry instead of accumulating one link per connection.
func hostPeerID(ws *workspace.Workspace) string {
	if host, ok := pinnedHost(ws); ok {
		return hex.EncodeToString(host.pin)
	}
	return "host"
}

// stayLive blocks until the host link ends or the context is cancelled, which is
// what makes a live Join a long-lived session rather than a one-shot transfer.
func stayLive(ctx context.Context, live *engine.Engine, peerID string, events sync.EventSink) error {
	defer live.Close()
	events.Emit(sync.EventInfo, "watching for changes; press Ctrl-C to stop")
	if err := live.WaitPeer(ctx, peerID); err != nil && ctx.Err() == nil {
		events.Emit(sync.EventDisconnected, "the host link ended: %v", err)
	}
	return nil
}

// hostTarget is where to reach a host and which fingerprint to pin.
type hostTarget struct {
	address string
	pin     []byte
}

// pinnedHost returns the stored host address and fingerprint, if this folder has
// ever paired. The fingerprint is stored hex-encoded, so it is decoded back to
// the full 32-byte digest here.
func pinnedHost(w *workspace.Workspace) (hostTarget, bool) {
	pinHex, err := w.GetMeta(workspace.MetaHostCert)
	if err != nil || pinHex == "" {
		return hostTarget{}, false
	}
	host, err := w.GetMeta(workspace.MetaRemoteHost)
	if err != nil || host == "" {
		return hostTarget{}, false
	}
	port, err := w.GetMeta(workspace.MetaRemotePort)
	if err != nil || port == "" {
		return hostTarget{}, false
	}
	pin, err := hex.DecodeString(pinHex)
	if err != nil {
		return hostTarget{}, false
	}
	return hostTarget{
		address: net.JoinHostPort(host, port),
		pin:     pin,
	}, true
}

// defaultAdvertiseHost picks a dialable address for a bind address.
func defaultAdvertiseHost(bind net.IP) string {
	if bind != nil && !bind.IsUnspecified() {
		return bind.String()
	}
	// 0.0.0.0 means "all interfaces", so advertise a concrete local address.
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}
