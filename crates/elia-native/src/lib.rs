//! A thin C ABI over [`elia_parse`], compiled as a shared library so Elia's
//! TypeScript side can call the structural edit check **in-process** through
//! `bun:ffi` — no `eliad`, no socket hop, and it runs even with the default
//! `ELIA_DAEMON=off`.
//!
//! The socket path (`src/daemon/`) still exists and is still the only option for
//! the JVM type-check (that genuinely needs a resident process). This library is
//! only the sub-millisecond bracket/quote/comment check, whose whole value is
//! latency — paying a daemon spawn or a connect for it defeats the point.
//!
//! Four symbols, mirrored in `src/native/ffi.ts`:
//!
//! | symbol | in | out |
//! | --- | --- | --- |
//! | `elia_native_check(ptr, len, lang)` | source bytes + [`Language`] tag | malloc'd JSON `{"ok":bool,"errors":[...]}`, caller frees |
//! | `elia_native_version()` | – | malloc'd version string, caller frees |
//! | `elia_native_free(ptr)` | a pointer from either call above | – |
//! | `elia_native_abi()` | – | ABI revision (`u32`), bumped on any signature change |
//!
//! Every entry point is panic-safe (`catch_unwind`) and fails open: on any
//! internal error it reports `{"ok":true,"errors":[]}` rather than blocking an
//! edit.

use std::ffi::{c_char, c_int, c_uint, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

use elia_parse::{check, Language};

/// Bumped whenever a symbol's signature or the JSON shape changes. `ffi.ts`
/// checks it on load and disables the fast path on a mismatch (a stale
/// `target/` build shadowing a newer source tree).
const ABI_REVISION: c_uint = 1;

/// Language tags — must match `elia_parse_lang` in the C header, `Language` in
/// `crates/elia-parse`, and `LANG` in `src/native/ffi.ts`.
fn language_from_tag(tag: c_int) -> Language {
    match tag {
        1 => Language::JsTs,
        2 => Language::Python,
        3 => Language::Rust,
        4 => Language::Go,
        _ => Language::Generic,
    }
}

const CLEAN_JSON: &str = r#"{"ok":true,"errors":[]}"#;

fn leak_cstring(s: String) -> *mut c_char {
    // NUL bytes can't appear in the JSON we generate or in a semver string;
    // if one somehow did, fail open with an empty-clean result.
    match CString::new(s) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new(CLEAN_JSON).unwrap().into_raw(),
    }
}

/// Run the structural check over `source` (`len` bytes, need not be
/// NUL-terminated) under the lexical rules for `lang`.
///
/// # Safety
/// `source` must point to at least `len` readable bytes, or be null (treated as
/// empty). The returned pointer must be released with [`elia_native_free`] and
/// not otherwise freed.
#[no_mangle]
pub unsafe extern "C" fn elia_native_check(
    source: *const c_char,
    len: usize,
    lang: c_int,
) -> *mut c_char {
    let json = catch_unwind(AssertUnwindSafe(|| {
        if source.is_null() || len == 0 {
            return CLEAN_JSON.to_string();
        }
        let bytes = slice::from_raw_parts(source as *const u8, len);
        let text = String::from_utf8_lossy(bytes);
        let result = check(&text, language_from_tag(lang));
        serde_json::to_string(&result).unwrap_or_else(|_| CLEAN_JSON.to_string())
    }))
    .unwrap_or_else(|_| CLEAN_JSON.to_string());
    leak_cstring(json)
}

/// Semantic version of this library, e.g. `"0.1.0"`. Caller frees with
/// [`elia_native_free`].
#[no_mangle]
pub extern "C" fn elia_native_version() -> *mut c_char {
    leak_cstring(env!("CARGO_PKG_VERSION").to_string())
}

/// The ABI revision this build speaks. See [`ABI_REVISION`].
#[no_mangle]
pub extern "C" fn elia_native_abi() -> c_uint {
    ABI_REVISION
}

/// Release a pointer returned by [`elia_native_check`] or
/// [`elia_native_version`].
///
/// # Safety
/// `s` must be a pointer from one of those two functions, passed exactly once.
#[no_mangle]
pub unsafe extern "C" fn elia_native_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    /// Drive a source string through the real C ABI and parse the JSON back.
    fn call(source: &str, lang: c_int) -> serde_json::Value {
        unsafe {
            let raw = elia_native_check(source.as_ptr() as *const c_char, source.len(), lang);
            assert!(!raw.is_null());
            let json = CStr::from_ptr(raw).to_str().unwrap().to_owned();
            elia_native_free(raw);
            serde_json::from_str(&json).unwrap()
        }
    }

    #[test]
    fn balanced_is_ok() {
        let v = call("function f() { return [1, 2, 3]; }", 1);
        assert_eq!(v["ok"], true);
        assert_eq!(v["errors"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn missing_brace_is_reported_with_position() {
        let v = call("function f() {\n  return 1;\n", 1);
        assert_eq!(v["ok"], false);
        assert_eq!(v["errors"][0]["line"], 1);
        assert_eq!(v["errors"][0]["message"], "unclosed '{'");
    }

    #[test]
    fn unknown_tag_falls_back_to_generic() {
        assert_eq!(call("{ (a + b) }", 999)["ok"], true);
        assert_eq!(call("{ (a + b] }", 42)["ok"], false);
    }

    #[test]
    fn empty_and_null_are_clean() {
        assert_eq!(call("", 1)["ok"], true);
        unsafe {
            let raw = elia_native_check(std::ptr::null(), 0, 1);
            let json = CStr::from_ptr(raw).to_str().unwrap().to_owned();
            elia_native_free(raw);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&json).unwrap()["ok"],
                true
            );
        }
    }

    #[test]
    fn invalid_utf8_does_not_crash() {
        unsafe {
            let bytes = [b'x', 0xff, 0xfe, b'{'];
            let raw = elia_native_check(bytes.as_ptr() as *const c_char, bytes.len(), 1);
            assert!(!raw.is_null());
            elia_native_free(raw);
        }
    }

    #[test]
    fn version_and_abi_are_reported() {
        unsafe {
            let raw = elia_native_version();
            let v = CStr::from_ptr(raw).to_str().unwrap().to_owned();
            elia_native_free(raw);
            assert!(!v.is_empty());
        }
        assert_eq!(elia_native_abi(), ABI_REVISION);
    }
}
