package sync

import "testing"

// everyDeclaredType is every MessageType this package declares. Go cannot
// enumerate constants, so the list is maintained here; the length check below
// is what keeps it honest in both directions.
var everyDeclaredType = []MessageType{
	TypeHello,
	TypeAuth,
	TypeWorkspaceInfo,
	TypeManifest,
	TypeFileRequest,
	TypeFileTransfer,
	TypeFileComplete,
	TypeAck,
	TypeError,
	TypeReconnect,
	TypePatch,
	TypeSyncDone,
	TypeConflict,
	TypePing,
	TypePong,
	TypeLeave,
	TypeControl,
}

// A type that is sent but missing from knownTypes is refused by Receive as a
// protocol error, and the engine treats ErrProtocol as an expected shutdown, so
// the frame silently ends the link's read loop instead of being dispatched. The
// set is therefore part of the wire contract, not a lookup convenience.
func TestKnownTypesCoversEveryDeclaredType(t *testing.T) {
	for _, typ := range everyDeclaredType {
		if !knownTypes[typ] {
			t.Errorf("%s is declared and sent but missing from knownTypes", typ)
		}
	}
	if len(knownTypes) != len(everyDeclaredType) {
		t.Errorf("knownTypes has %d entries, %d types are declared; update everyDeclaredType or knownTypes",
			len(knownTypes), len(everyDeclaredType))
	}
}

// Receive must accept each declared type, since acceptance is checked against
// knownTypes before dispatch and nothing else catches a gap.
func TestReceiveAcceptsEveryDeclaredType(t *testing.T) {
	for _, typ := range everyDeclaredType {
		server, client := newTestConnPair(t)
		if err := client.Send(typ, struct{}{}); err != nil {
			t.Fatalf("send %s: %v", typ, err)
		}
		got, _, err := server.Receive()
		if err != nil {
			t.Errorf("receive %s: %v", typ, err)
			server.Close()
			client.Close()
			continue
		}
		if got != typ {
			t.Errorf("received %s, sent %s", got, typ)
		}
		server.Close()
		client.Close()
	}
}
