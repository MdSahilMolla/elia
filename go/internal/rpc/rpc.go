// Package rpc frames the NDJSON protocol spoken over stdio by elia-index.
//
// It mirrors the eliad JSON-RPC idiom (id / method / params / result+error) in
// a single-request-per-line form suited to a short-lived child process: the
// TypeScript side writes one line, reads one line, then closes stdin. The exact
// field shapes are mirrored in src/goindex/types.ts — keep the two in lockstep
// and bump ProtocolVersion on any breaking change.
package rpc

// ProtocolVersion is checked by the TypeScript client on every response. A
// mismatch disables the fast path (falls back to ripgrep / pure-JS) rather
// than risk decoding a changed shape.
const ProtocolVersion = 1

// Version reports the protocol version this binary speaks.
func Version() int { return ProtocolVersion }

// Request is one stdin line.
type Request struct {
	ID     int64          `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// Response is one stdout line.
type Response struct {
	ID       int64      `json:"id"`
	Protocol int        `json:"protocol"`
	Result   any        `json:"result,omitempty"`
	Error    *ErrorBody `json:"error,omitempty"`
}

// ErrorBody codes: -32700 malformed request, -32601 unknown method, -32602
// invalid params (including a pattern Go cannot compile — the client surfaces
// these as plain errors, exactly like the other search backends), -32603
// internal failure (the client treats these as transport problems and falls
// back to the next backend).
type ErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
