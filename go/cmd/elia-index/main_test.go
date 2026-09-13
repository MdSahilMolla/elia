package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"elia-go/internal/rpc"
)

func TestOversizedRequestIsAnsweredAndServingContinues(t *testing.T) {
	big := `{"id":42,"method":"index.query","params":{"pattern":"` + strings.Repeat("x", maxRequestBytes) + `"}}`
	input := big + "\n" + `{"id":43,"method":"index.info","params":{}}` + "\n"
	var out bytes.Buffer
	serve(strings.NewReader(input), &out)

	var responses []rpc.Response
	dec := json.NewDecoder(&out)
	for dec.More() {
		var r rpc.Response
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("decode: %v", err)
		}
		responses = append(responses, r)
	}
	if len(responses) != 2 {
		t.Fatalf("want 2 responses, got %d", len(responses))
	}
	if responses[0].ID != 42 || responses[0].Error == nil || !strings.Contains(responses[0].Error.Message, "exceeds") {
		t.Fatalf("oversized request should get an error for id 42, got %+v", responses[0])
	}
	if responses[1].ID != 43 || responses[1].Error != nil {
		t.Fatalf("the next request should be served normally, got %+v", responses[1])
	}
}

func TestReadRequestHandlesAFinalUnterminatedLine(t *testing.T) {
	r := bufio.NewReaderSize(strings.NewReader("a\r\nb"), 16)
	for _, want := range []string{"a\r\n", "b"} {
		line, tooLong, err := readRequest(r, 100)
		if err != nil || tooLong || string(line) != want {
			t.Fatalf("want %q, got %q tooLong=%v err=%v", want, line, tooLong, err)
		}
	}
	if _, _, err := readRequest(r, 100); err == nil {
		t.Fatal("want EOF")
	}
}

func TestLeadingID(t *testing.T) {
	cases := map[string]int64{
		`{"id":7,"method":"x"}`: 7,
		`{ "id" : 12 ,`:         12,
		`{"method":"x"}`:        0,
		`{"id":"nope"}`:         0,
	}
	for in, want := range cases {
		if got := leadingID([]byte(in)); got != want {
			t.Errorf("leadingID(%q) = %d, want %d", in, got, want)
		}
	}
}
