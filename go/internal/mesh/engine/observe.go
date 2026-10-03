package engine

import (
	wsync "elia-go/internal/mesh/sync"
)

// ObserveLocalChange records a local edit that has been sent to at least one
// peer. The patch counts and body come from the diff that was actually built for
// the wire, so they describe the change the peer received rather than one
// recomputed here.
func (e *Engine) ObserveLocalChange(change *wsync.FileChange, patch string) {
	if change == nil {
		return
	}
	ev := wsync.ChangeEvent{
		Path:        change.Path,
		Op:          change.Op,
		OriginNode:  wsync.OriginLocal,
		BaseVersion: change.BaseVersion,
		Version:     change.Version,
		OldHash:     change.OldHash,
		NewHash:     change.NewHash,
		Size:        change.Size,
		Patch:       patch,
	}
	if patch != "" {
		if added, removed, ok := wsync.DiffCounts(patch); ok {
			ev.Added, ev.Removed = &added, &removed
		}
	}
	e.changes.Observe(ev)
}

// ObserveApplied records a change received from a peer and written locally. The
// body is the incoming patch when there was one, and empty for a whole-file
// transfer: the receiver has no diff to count in that case, and inventing one
// would report line counts for a transfer that never had a patch.
func (e *Engine) ObserveApplied(l *link, change wsync.FileChange, incomingPatch string, size int64, newHash string) {
	ev := wsync.ChangeEvent{
		Path:        change.Path,
		Op:          change.Op,
		OriginNode:  l.peerID,
		BaseVersion: change.BaseVersion,
		Version:     change.Version,
		OldHash:     change.OldHash,
		NewHash:     newHash,
		Size:        size,
		Patch:       incomingPatch,
	}
	if incomingPatch != "" {
		if added, removed, ok := wsync.DiffCounts(incomingPatch); ok {
			ev.Added, ev.Removed = &added, &removed
		}
	}
	e.changes.Observe(ev)
}

// ObserveDeleteApplied records a peer deletion that was applied. There is no body
// and no line count: the absence of the file is the whole change.
func (e *Engine) ObserveDeleteApplied(l *link, change wsync.FileChange) {
	e.changes.Observe(wsync.ChangeEvent{
		Path:        change.Path,
		Op:          wsync.OpDelete,
		OriginNode:  l.peerID,
		BaseVersion: change.BaseVersion,
		Version:     change.Version,
		OldHash:     change.OldHash,
	})
}

// ObserveConflict records a change that was not applied: preserved as a
// divergence, or refused outright. The reason travels with it, because a
// conflict a consumer cannot describe is one it cannot show the user.
func (e *Engine) ObserveConflict(l *link, change wsync.FileChange, kind, reason, keptPath string) {
	if reason == "" {
		reason = kind
	} else {
		reason = kind + ": " + reason
	}
	e.changes.Observe(wsync.ChangeEvent{
		Path:        change.Path,
		Op:          change.Op,
		OriginNode:  l.peerID,
		BaseVersion: change.BaseVersion,
		Version:     change.Version,
		OldHash:     change.OldHash,
		NewHash:     change.NewHash,
		Size:        change.Size,
		Conflict:    true,
		KeptPath:    keptPath,
		Reason:      reason,
	})
}
