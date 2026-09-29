use std::path::PathBuf;

fn main() {
    // native/elia-box-fs lives two levels up from crates/elia-box.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root")
        .join("native")
        .join("elia-box-fs");
    let src = root.join("src").join("fs.cpp");
    let include = root.join("include");

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include(&include)
        .file(&src)
        .flag_if_supported("-fno-rtti")
        .warnings(true)
        .compile("elia_box_fs");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", include.join("elia_box_fs.h").display());
    println!("cargo:rerun-if-changed=build.rs");
}
