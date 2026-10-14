package session

import "testing"

func TestNormalizeListenAddr(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "", want: "127.0.0.1:0"},
		{in: "127.0.0.1:0", want: "127.0.0.1:0"},
		{in: "0.0.0.0", want: "0.0.0.0:0"},
		{in: "192.168.1.42", want: "192.168.1.42:0"},
		{in: "8080", want: "127.0.0.1:8080"},
		{in: "0.0.0.0:8080", want: "0.0.0.0:8080"},
		{in: "localhost:9999", want: "localhost:9999"},
		{in: ":8080", wantErr: true},
		{in: "host:port:notaport", wantErr: true},
	}
	for _, tt := range tests {
		got, err := normalizeListenAddr(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("normalizeListenAddr(%q) = %q, want an error", tt.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeListenAddr(%q): %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("normalizeListenAddr(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
