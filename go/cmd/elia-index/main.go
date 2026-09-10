// elia-index: the Go workspace-search sidecar (pilot).
//
// A short-lived stdio process: read one NDJSON request line, write one NDJSON
// response line, repeat until stdin closes. All diagnostics go to stderr so
// stdout stays pure protocol. See go/README.md for the contract.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"elia-go/internal/index"
	"elia-go/internal/rpc"
)

const version = "0.1.0"

func main() {
	fmt.Fprintf(os.Stderr, "elia-index %s ready\n", version)
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(os.Stdout)
	for in.Scan() {
		line := in.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req rpc.Request
		resp := rpc.Response{Protocol: rpc.Version()}
		if err := json.Unmarshal(line, &req); err != nil {
			resp.Error = &rpc.ErrorBody{Code: -32700, Message: "parse error"}
			if enc.Encode(resp) != nil {
				return
			}
			continue
		}
		resp.ID = req.ID
		handle(req, &resp)
		if enc.Encode(resp) != nil {
			return
		}
	}
}

func handle(req rpc.Request, resp *rpc.Response) {
	defer func() {
		if r := recover(); r != nil {
			resp.Result = nil
			resp.Error = &rpc.ErrorBody{Code: -32603, Message: fmt.Sprintf("internal error: %v", r)}
		}
	}()
	switch req.Method {
	case "index.info":
		resp.Result = map[string]any{"version": version, "protocol": rpc.Version()}
	case "index.query":
		pattern, dir, globPattern, context, err := queryParams(req.Params)
		if err != nil {
			resp.Error = &rpc.ErrorBody{Code: -32602, Message: err.Error()}
			return
		}
		res, err := index.Query(pattern, dir, globPattern, context)
		if err != nil {
			// Invalid request shapes (bad pattern, bad bounds) surface as
			// plain errors so the client reports them like the other
			// backends instead of silently falling back.
			resp.Error = &rpc.ErrorBody{Code: -32602, Message: err.Error()}
			return
		}
		resp.Result = res
	default:
		resp.Error = &rpc.ErrorBody{Code: -32601, Message: "method not found: " + req.Method}
	}
}

// queryParams decodes index.query params. Numbers arrive as float64; context
// must be a whole number because the TypeScript side only ever sends integers.
func queryParams(params map[string]any) (pattern, dir, globPattern string, context int, err error) {
	pattern, _ = params["pattern"].(string)
	dir, _ = params["dir"].(string)
	globPattern, _ = params["glob"].(string)
	raw, present := params["context"]
	if !present {
		return pattern, dir, globPattern, 0, nil
	}
	num, ok := raw.(float64)
	if !ok || num != float64(int(num)) {
		return "", "", "", 0, fmt.Errorf("context must be an integer from 0 to 20")
	}
	return pattern, dir, globPattern, int(num), nil
}
