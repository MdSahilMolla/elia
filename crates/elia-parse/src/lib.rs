//! Safe bindings for `native/elia-parse` — a sub-millisecond structural check
//! for source edits. Not a parser: it reports unbalanced brackets and
//! unterminated strings / chars / comments so Elia can reject a broken
//! `edit_file` result before paying for a failed build.

use std::ffi::{c_char, c_int, CStr};

use serde::{Deserialize, Serialize};

#[link(name = "elia_parse", kind = "static")]
extern "C" {
    fn elia_parse_check_json(source: *const c_char, len: usize, lang: c_int) -> *mut c_char;
    fn elia_parse_free_string(s: *mut c_char);
    fn elia_parse_version() -> *const c_char;
}

/// Selects the lexical rules. Values match `elia_parse_lang` in the C header.
#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Generic = 0,
    JsTs = 1,
    Python = 2,
    Rust = 3,
    Go = 4,
}

impl Language {
    /// Pick rules from a file path's extension; unknown extensions get
    /// [`Language::Generic`] (C-family), which is a safe superset for most
    /// brace languages.
    pub fn from_path(path: &str) -> Language {
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        match ext.as_str() {
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Language::JsTs,
            "py" | "pyi" => Language::Python,
            "rs" => Language::Rust,
            "go" => Language::Go,
            _ => Language::Generic,
        }
    }

    /// Parse an explicit hint like `"ts"`, `"python"`, `"rust"`. Returns `None`
    /// for an unrecognised hint so the caller can fall back to the path.
    pub fn from_hint(hint: &str) -> Option<Language> {
        match hint.trim().to_ascii_lowercase().as_str() {
            "js" | "jsx" | "ts" | "tsx" | "javascript" | "typescript" => Some(Language::JsTs),
            "py" | "python" => Some(Language::Python),
            "rs" | "rust" => Some(Language::Rust),
            "go" | "golang" => Some(Language::Go),
            "generic" | "c" | "cpp" | "c++" | "java" => Some(Language::Generic),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckError {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckResult {
    pub ok: bool,
    pub errors: Vec<CheckError>,
}

impl CheckResult {
    fn clean() -> Self {
        Self {
            ok: true,
            errors: Vec::new(),
        }
    }
}

/// Run the structural check. Always returns a result — an internal failure is
/// reported as `ok: true` (fail open: never block an edit because the checker
/// itself had a problem).
pub fn check(source: &str, lang: Language) -> CheckResult {
    if source.is_empty() {
        return CheckResult::clean();
    }
    // SAFETY: we pass ptr + byte length (source may contain interior NULs), the
    // C side only reads `len` bytes, and we free exactly what it returned.
    let json = unsafe {
        let raw = elia_parse_check_json(
            source.as_ptr() as *const c_char,
            source.len(),
            lang as c_int,
        );
        if raw.is_null() {
            return CheckResult::clean();
        }
        let owned = CStr::from_ptr(raw).to_string_lossy().into_owned();
        elia_parse_free_string(raw);
        owned
    };
    serde_json::from_str(&json).unwrap_or_else(|_| CheckResult::clean())
}

/// Version string of the linked C++ library.
pub fn version() -> &'static str {
    // SAFETY: the C side returns a pointer to a static NUL-terminated string.
    unsafe {
        CStr::from_ptr(elia_parse_version())
            .to_str()
            .unwrap_or("0.0.0")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balanced_code_is_clean() {
        let r = check(
            "fn main() { let v = vec![1, 2, 3]; println!(\"{}\", v.len()); }",
            Language::Rust,
        );
        assert!(r.ok, "{r:?}");
        assert!(r.errors.is_empty());
    }

    #[test]
    fn missing_close_brace_is_reported() {
        let r = check(
            "function f() {\n  if (x) {\n    return 1;\n  }\n",
            Language::JsTs,
        );
        assert!(!r.ok);
        assert_eq!(r.errors[0].message, "unclosed '{'");
        assert_eq!(r.errors[0].line, 1);
    }

    #[test]
    fn unterminated_string_is_reported() {
        let r = check("const s = \"hello;\nconst n = 1;\n", Language::JsTs);
        assert!(!r.ok);
        assert!(r.errors[0].message.contains("unterminated string"));
    }

    #[test]
    fn mismatched_bracket_is_reported() {
        let r = check("let a = (1 + [2 * 3)];", Language::Generic);
        assert!(!r.ok);
        assert!(r
            .errors
            .iter()
            .any(|e| e.message.contains("does not match")));
    }

    #[test]
    fn braces_inside_strings_and_comments_are_ignored() {
        let src = r#"
            // a lone } in a comment
            const re = "a { b ) c";
            /* another { */
            const ok = { a: 1 };
        "#;
        assert!(check(src, Language::JsTs).ok);
    }

    #[test]
    fn template_literal_interpolation_tracks_braces() {
        assert!(check("const x = `a ${ obj.get({ k: 1 }) } b`;", Language::JsTs).ok);
        let bad = check("const x = `a ${ obj.get({ k: 1 ) } b`;", Language::JsTs);
        assert!(!bad.ok);
    }

    /// Regression: the interpolation guard used to ask whether the top of the
    /// shared bracket stack was a `{`, which is only true at file scope. Inside
    /// any enclosing brace the top is the *enclosing* brace, so the guard failed
    /// and every one of these valid snippets was reported as an unterminated
    /// template literal — and, since this check gates writes, refused outright.
    #[test]
    fn template_literal_inside_an_enclosing_scope() {
        let cases = [
            // function body — the shape that was actually rejected in the wild
            "async function apiGet(path: string) {\n  const url = `${BASE_URL}${path}`;\n}",
            // object literal
            "const headers = {\n  Authorization: `Bearer ${token}`,\n};",
            // if block
            "if (a) {\n  throw new Error(`bad ${a}`);\n}",
            // class body
            "class A {\n  url() {\n    return `${this.base}/x`;\n  }\n}",
            // nested braces inside the interpolation, inside a function
            "function f() {\n  return `a ${ obj.get({ k: 1 }) } b`;\n}",
            // arrow body, two interpolations back to back
            "const f = () => {\n  return `${a}${b}`;\n};",
        ];
        for src in cases {
            let r = check(src, Language::JsTs);
            assert!(r.ok, "expected ok for {src:?}, got {:?}", r.errors);
        }
    }

    /// TSX: an interpolation inside a JSX attribute expression sits two braces
    /// deep — the component body and the `{...}` attribute.
    #[test]
    fn template_literal_inside_jsx_attribute() {
        let src = "export function Card({ n }: { n: number }) {\n  return <div className={`card ${n}`} />;\n}";
        let r = check(src, Language::JsTs);
        assert!(r.ok, "expected ok, got {:?}", r.errors);
    }

    /// The fix must not blunt the check: a genuinely unterminated template
    /// inside a function is still an error.
    #[test]
    fn unterminated_template_inside_a_function_is_still_reported() {
        let r = check("function f() {\n  const s = `oops ${x};\n}", Language::JsTs);
        assert!(!r.ok);
        assert!(r
            .errors
            .iter()
            .any(|e| e.message.contains("unterminated template literal")));
    }

    #[test]
    fn rust_nested_block_comment() {
        assert!(
            check(
                "/* outer /* inner */ still comment */ fn a() {}",
                Language::Rust
            )
            .ok
        );
        assert!(!check("/* outer /* inner */ fn a() {}", Language::Rust).ok);
    }

    #[test]
    fn rust_lifetimes_are_not_char_literals() {
        assert!(check("fn f<'a>(x: &'a str) -> &'a str { x }", Language::Rust).ok);
    }

    #[test]
    fn rust_raw_strings() {
        assert!(
            check(
                r####"let s = r#"a "quoted" { brace"#; let t = 1;"####,
                Language::Rust
            )
            .ok
        );
    }

    #[test]
    fn python_triple_quotes() {
        assert!(
            check(
                "x = \"\"\"\nunbalanced ( in a docstring\n\"\"\"\ny = 1\n",
                Language::Python
            )
            .ok
        );
        assert!(!check("x = \"\"\"\nunterminated\n", Language::Python).ok);
    }

    #[test]
    fn python_has_no_block_comments() {
        // `/*` is just division-and-splat in Python; must not start a comment.
        assert!(check("a = b /* c\nd = 1\n", Language::Python).ok);
    }

    #[test]
    fn from_path_maps_extensions() {
        assert_eq!(Language::from_path("src/app.tsx"), Language::JsTs);
        assert_eq!(Language::from_path("main.rs"), Language::Rust);
        assert_eq!(Language::from_path("x.py"), Language::Python);
        assert_eq!(Language::from_path("Makefile"), Language::Generic);
    }

    #[test]
    fn version_is_reported() {
        assert!(!version().is_empty());
    }
}
