/*
 * elia-parse — a fast structural check for source edits.
 *
 * One linear pass over a buffer, aware of the language's string, char, and
 * comment syntax, reporting unbalanced brackets and unterminated
 * literals/comments. It is not a parser and knows nothing about grammar; its
 * whole job is to let Elia reject a syntactically broken `edit_file` result in
 * well under a millisecond, instead of after a failed build round-trip.
 *
 * C ABI so the Rust wrapper in `crates/elia-parse` can bind it with a plain
 * `extern "C"` block and no `cxx` bridge.
 */
#ifndef ELIA_PARSE_H
#define ELIA_PARSE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Selects the lexical rules. Values are matched in crates/elia-parse/src/lib.rs.
 *   GENERIC  C-family line and block comments, double- and single-quote literals
 *   JS_TS    also backtick template literals with dollar-brace interpolation
 *   PYTHON   hash comments, triple-quoted strings, no braces or block comments
 *   RUST     nestable block comments, raw string literals
 *   GO       also backtick raw strings (no interpolation)
 */
typedef enum elia_parse_lang {
  ELIA_PARSE_GENERIC = 0,
  ELIA_PARSE_JS_TS = 1,
  ELIA_PARSE_PYTHON = 2,
  ELIA_PARSE_RUST = 3,
  ELIA_PARSE_GO = 4
} elia_parse_lang;

/*
 * Analyze `source` (`len` bytes, need not be NUL-terminated).
 *
 * Returns a malloc'd JSON string the caller must free with
 * `elia_parse_free_string`:
 *   {"ok":true,"errors":[]}
 *   {"ok":false,"errors":[{"line":12,"column":1,"message":"unclosed '{'"}]}
 *
 * Returns NULL only on allocation failure.
 */
char *elia_parse_check_json(const char *source, size_t len, int lang);

void elia_parse_free_string(char *s);

/* Semantic version of this library, e.g. "0.1.0". Static storage. */
const char *elia_parse_version(void);

#ifdef __cplusplus
}
#endif

#endif /* ELIA_PARSE_H */
