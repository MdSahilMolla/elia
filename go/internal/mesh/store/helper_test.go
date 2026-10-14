package store

import "time"

// timeUnix is a test helper for building PeerRow timestamps.
func timeUnix(sec int64) time.Time { return time.Unix(sec, 0).UTC() }
