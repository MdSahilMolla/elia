package sync

// SendRaw writes an arbitrary payload as a frame, bypassing envelope encoding.
// Tests use it to simulate a malformed or hostile peer.
func (c *Conn) SendRaw(payload string) error {
	return c.raw.WriteFrame([]byte(payload))
}

// WriteRawHeader writes an unvalidated length prefix. It is exported for tests
// in this package's internal test files; production code should use Send.
func (c *Conn) WriteRawHeader(n uint32) error {
	return c.raw.WriteUnvalidatedHeader(n)
}
