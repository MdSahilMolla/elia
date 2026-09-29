/*
 * elia-box-fs: the copy-on-write workspace layer of elia-box.
 *
 * A candidate (an evolve generation, a trial run, a risky command) should never
 * touch the tree it was cloned from. This library gives elia-box three things:
 *
 *   fork      an instant copy-on-write clone of a directory tree (APFS clonefile
 *             where the filesystem has it, a byte copy elsewhere);
 *   snapshot  a deterministic manifest of a tree: path, kind, mode, size, SHA-256;
 *   diff      the added / modified / deleted paths between two manifests.
 *
 * Plus sha256 over a buffer, so the receipt hash needs no extra dependency.
 *
 * Every function that returns a `char *` returns a malloc'd, NUL-terminated
 * string the caller releases with ebfs_free. NULL means failure; ebfs_last_error
 * then describes it (thread-local, valid until the next call on that thread).
 */
#ifndef ELIA_BOX_FS_H
#define ELIA_BOX_FS_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Clone `src` to `dst` (which must not exist). Returns 0 on success, -1 on
 * failure. `*used_clone` is set to 1 when the clone was copy-on-write and 0 when
 * bytes were copied. Symlinks are recreated as symlinks and never followed. */
int ebfs_fork(const char *src, const char *dst, int *used_clone);

/* Manifest of `root`, one line per entry, sorted by path:
 *   <kind>\t<mode-octal>\t<size>\t<sha256|target|->\t<relative path>\n
 * kind is F (file), D (directory) or L (symlink; the hash column is the link
 * target). Names in `excludes` (a '\n'-separated list of directory or file
 * base names, e.g. "node_modules\n.git") are skipped wherever they appear. */
char *ebfs_snapshot(const char *root, const char *excludes);

/* Compare two manifests from ebfs_snapshot. Returns a JSON object
 *   {"added":[...],"modified":[...],"deleted":[...]}
 * where each array holds relative paths (files, symlinks and directories). */
char *ebfs_diff(const char *before, const char *after);

/* Lower-case hex SHA-256 of `len` bytes at `data`. */
char *ebfs_sha256_hex(const unsigned char *data, size_t len);

/* Recursively remove `path` without following symlinks. 0 on success. */
int ebfs_remove_tree(const char *path);

const char *ebfs_last_error(void);
void ebfs_free(char *p);

#ifdef __cplusplus
}
#endif

#endif
