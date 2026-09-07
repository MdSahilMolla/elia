use std::path::PathBuf;

fn main() {
    // native/elia-parse lives two levels up from crates/elia-parse.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root")
        .join("native")
        .join("elia-parse");

    let src = root.join("src").join("validator.cpp");
    let include = root.join("include");
    let header = include.join("elia_parse.h");

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include(&include)
        .file(&src)
        .flag_if_supported("-fno-exceptions")
        .flag_if_supported("-fno-rtti")
        .warnings(true)
        .compile("elia_parse");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", header.display());
    println!("cargo:rerun-if-changed=build.rs");
}
