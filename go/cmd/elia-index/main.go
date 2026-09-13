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
	"io"
	"os"
	"strconv"

	"elia-go/internal/index"
	"elia-go/internal/rpc"
)

const version = "0.1.0"

// maxRequestBytes bounds one request line. A real index.query is tiny (the
// pattern is capped at 10k characters), so this only ever stops a broken or
// hostile client.
const maxRequestBytes = 4 * 1024 * 1024

func main() {
	fmt.Fprintf(os.Stderr, "elia-index %s ready\n", version)
	serve(os.Stdin, os.Stdout)
}

func serve(stdin io.Reader, stdout io.Writer) {
	in := bufio.NewReaderSize(stdin, 64*1024)
	enc := json.NewEncoder(stdout)
	for {
		line, tooLong, err := readRequest(in, maxRequestBytes)
		if err != nil {
			return
		}
		if tooLong {
			// This used to be a bufio.Scanner, which stops for good on a line
			// over its buffer: the process exited mid-conversation and the
			// client saw only EOF. Answer instead, and keep serving.
			resp := rpc.Response{ID: leadingID(line), Protocol: rpc.Version()}
			resp.Error = &rpc.ErrorBody{Code: -32700, Message: fmt.Sprintf("request exceeds %d bytes", maxRequestBytes)}
			if enc.Encode(resp) != nil {
				return
			}
			continue
		}
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

// readRequest reads one line of at most max bytes (not counting its line
// ending). An over-long line is read to its end and discarded, so the next
// request still frames; only its first bytes are returned, for leadingID. err
// is non-nil only at EOF (or a read failure) with nothing left to return.
func readRequest(r *bufio.Reader, max int) (line []byte, tooLong bool, err error) {
	for {
		chunk, readErr := r.ReadSlice('\n')
		if !tooLong {
			line = append(line, chunk...)
			if len(bytes.TrimRight(line, "\r\n")) > max {
				tooLong = true
				line = line[:min(len(line), 64):min(len(line), 64)]
			}
		}
		if readErr == bufio.ErrBufferFull {
			continue
		}
		if readErr != nil && len(line) == 0 && !tooLong {
			return nil, false, readErr
		}
		return line, tooLong, nil
	}
}

// leadingID recovers the id from the start of a request line such as
// {"id":42,"method":…, so an error for an unparseable line still reaches the
// right caller. 0 when it cannot be read.
func leadingID(prefix []byte) int64 {
	at := bytes.Index(prefix, []byte(`"id"`))
	if at < 0 {
		return 0
	}
	rest := bytes.TrimLeft(prefix[at+4:], " \t")
	if len(rest) == 0 || rest[0] != ':' {
		return 0
	}
	rest = bytes.TrimLeft(rest[1:], " \t")
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	id, err := strconv.ParseInt(string(rest[:end]), 10, 64)
	if err != nil {
		return 0
	}
	return id
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
