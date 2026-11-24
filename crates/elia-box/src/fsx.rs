//! Safe bindings for native/elia-box-fs (C++): fork, snapshot, diff, sha256.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::ffi::{c_char, c_int, CStr, CString};
use std::path::Path;

extern "C" {
    fn ebfs_fork(src: *const c_char, dst: *const c_char, used_clone: *mut c_int) -> c_int;
    fn ebfs_snapshot(root: *const c_char, excludes: *const c_char) -> *mut c_char;
    fn ebfs_diff(before: *const c_char, after: *const c_char) -> *mut c_char;
    fn ebfs_sha256_hex(data: *const u8, len: usize) -> *mut c_char;
    fn ebfs_remove_tree(path: *const c_char) -> c_int;
    fn ebfs_last_error() -> *const c_char;
    fn ebfs_free(p: *mut c_char);
}

fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| anyhow!("string contains a NUL byte"))
}

fn path_cstr(p: &Path) -> Result<CString> {
    cstr(
        p.to_str()
            .ok_or_else(|| anyhow!("path is not valid UTF-8: {}", p.display()))?,
    )
}

fn last_error() -> String {
    unsafe {
        CStr::from_ptr(ebfs_last_error())
            .to_string_lossy()
            .into_owned()
    }
}

fn take(p: *mut c_char) -> Result<String> {
    if p.is_null() {
        return Err(anyhow!("{}", last_error()));
    }
    let s = unsafe { CStr::from_ptr(p).to_string_lossy().into_owned() };
    unsafe { ebfs_free(p) };
    Ok(s)
}

/// Copy-on-write clone of `src` to the not-yet-existing `dst`. Returns whether the
/// clone was copy-on-write (true) or a byte copy (false).
pub fn fork(src: &Path, dst: &Path) -> Result<bool> {
    let (s, d) = (path_cstr(src)?, path_cstr(dst)?);
    let mut cloned: c_int = 0;
    let rc = unsafe { ebfs_fork(s.as_ptr(), d.as_ptr(), &mut cloned) };
    if rc != 0 {
        return Err(anyhow!(
            "fork {} -> {}: {}",
            src.display(),
            dst.display(),
            last_error()
        ));
    }
    Ok(cloned == 1)
}

pub fn snapshot(root: &Path, excludes: &[String]) -> Result<String> {
    let r = path_cstr(root)?;
    let e = cstr(&excludes.join("\n"))?;
    take(unsafe { ebfs_snapshot(r.as_ptr(), e.as_ptr()) })
}

#[derive(Debug, Default, Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Changes {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
}

pub fn diff(before: &str, after: &str) -> Result<Changes> {
    let (b, a) = (cstr(before)?, cstr(after)?);
    let json = take(unsafe { ebfs_diff(b.as_ptr(), a.as_ptr()) })?;
    Ok(serde_json::from_str(&json)?)
}

pub fn sha256_hex(data: &[u8]) -> String {
    take(unsafe { ebfs_sha256_hex(data.as_ptr(), data.len()) }).unwrap_or_default()
}

pub fn remove_tree(path: &Path) -> Result<()> {
    let p = path_cstr(path)?;
    if unsafe { ebfs_remove_tree(p.as_ptr()) } != 0 {
        return Err(anyhow!("{}", last_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("eb-fsx-{}-{}", name, std::process::id()));
        let _ = remove_tree(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // a message longer than one block, crossing the padding boundary
        assert_eq!(
            sha256_hex(&[b'a'; 1000]),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        );
    }

    #[test]
    fn fork_isolates_the_original_and_diff_reports_changes() {
        let root = tmp("fork");
        let src = root.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("keep.txt"), "keep").unwrap();
        fs::write(src.join("edit.txt"), "before").unwrap();
        fs::write(src.join("sub/gone.txt"), "gone").unwrap();
        fs::create_dir_all(src.join("node_modules")).unwrap();
        fs::write(src.join("node_modules/x.js"), "x").unwrap();
        std::os::unix::fs::symlink("keep.txt", src.join("link")).unwrap();

        let dst = root.join("dst");
        fork(&src, &dst).unwrap();
        let ex = vec!["node_modules".to_string()];
        let before = snapshot(&dst, &ex).unwrap();
        assert!(!before.contains("node_modules"));
        assert_eq!(
            before,
            snapshot(&src, &ex).unwrap(),
            "a fresh fork has an identical manifest"
        );

        fs::write(dst.join("edit.txt"), "after!").unwrap();
        fs::write(dst.join("new.txt"), "new").unwrap();
        fs::remove_file(dst.join("sub/gone.txt")).unwrap();
        let after = snapshot(&dst, &ex).unwrap();
        let ch = diff(&before, &after).unwrap();
        assert_eq!(ch.added, vec!["new.txt"]);
        assert_eq!(ch.modified, vec!["edit.txt"]);
        assert_eq!(ch.deleted, vec!["sub/gone.txt"]);

        assert_eq!(
            fs::read_to_string(src.join("edit.txt")).unwrap(),
            "before",
            "the original is untouched"
        );
        assert!(src.join("sub/gone.txt").exists());
        assert!(
            fork(&src, &dst).is_err(),
            "an existing destination is refused"
        );
        remove_tree(&root).unwrap();
    }

    #[test]
    fn remove_tree_does_not_follow_symlinks_and_refuses_root() {
        let root = tmp("rm");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious"), "p").unwrap();
        let victim = root.join("victim");
        fs::create_dir_all(&victim).unwrap();
        std::os::unix::fs::symlink(&outside, victim.join("escape")).unwrap();
        remove_tree(&victim).unwrap();
        assert!(
            outside.join("precious").exists(),
            "a symlink is unlinked, never followed"
        );
        assert!(remove_tree(Path::new("/")).is_err());
        assert!(remove_tree(Path::new("")).is_err());
        remove_tree(&root).unwrap();
    }
}
