use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

const DEVELOPMENT_KEY_SOURCE: [u8; 32] = [
    0, 87, 223, 175, 225, 117, 69, 121, 189, 102, 69, 25, 165, 255, 167, 35, 98, 59, 156, 76, 67,
    239, 14, 79, 122, 44, 84, 81, 113, 53, 88, 6,
];

fn main() {
    println!("cargo:rerun-if-env-changed=LINECUT_PROJECT_BUILD_SECRET_V1");
    generate_project_key_material();
    tauri_build::build()
}

fn generate_project_key_material() {
    let configured_secret = env::var("LINECUT_PROJECT_BUILD_SECRET_V1").ok();
    if let Some(secret) = configured_secret.as_deref() {
        assert!(
            secret.len() >= 32,
            "LINECUT_PROJECT_BUILD_SECRET_V1 must contain at least 32 bytes"
        );
    } else if env::var("PROFILE").as_deref() == Ok("release") {
        println!(
            "cargo:warning=release build is using the development project-file key; set LINECUT_PROJECT_BUILD_SECRET_V1 for official releases"
        );
    }

    let source = configured_secret
        .as_deref()
        .map(str::as_bytes)
        .unwrap_or(&DEVELOPMENT_KEY_SOURCE);
    let root = digest_with_context(b"LineCut/project-build/root/v1", source);
    let mask = digest_with_context(b"LineCut/project-build/mask/v1", source);
    let masked = std::array::from_fn::<_, 32, _>(|index| root[index] ^ mask[index]);

    let generated = format!(
        "const BUILD_KEY_MASK: [u8; 32] = {mask:?};\nconst BUILD_KEY_MASKED: [u8; 32] = {masked:?};\n"
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set"))
        .join("linecut_project_key.rs");
    fs::write(output, generated).expect("failed to write generated project key material");
}

fn digest_with_context(context: &[u8], source: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(source);
    hasher.finalize().into()
}
