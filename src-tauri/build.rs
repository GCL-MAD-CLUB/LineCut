use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

const DEVELOPMENT_KEY_SOURCE: [u8; 32] = [
    0, 87, 223, 175, 225, 117, 69, 121, 189, 102, 69, 25, 165, 255, 167, 35, 98, 59, 156, 76, 67,
    239, 14, 79, 122, 44, 84, 81, 113, 53, 88, 6,
];
const LOCAL_RELEASE_SECRET_FILE: &str = ".linecut-project-build-secret-v1.local";

fn main() {
    println!("cargo:rerun-if-env-changed=LINECUT_PROJECT_BUILD_SECRET_V1");
    println!("cargo:rerun-if-changed={LOCAL_RELEASE_SECRET_FILE}");
    generate_project_key_material();
    let mut attributes = tauri_build::Attributes::new();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows")
            .join("app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // Link the manifest into every target, including the lib unit-test EXE.
        // Tauri's normal application resources do not reach that test harness.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // The linker supplies the manifest; keep Tauri's icon/version resources
        // without embedding a second manifest through the resource compiler.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to build Tauri resources");
}

fn generate_project_key_material() {
    let is_release_build = env::var("PROFILE").as_deref() == Ok("release");
    // Development builds intentionally keep using the stable development key so they can open
    // existing development project files. Only release builds may use the release key.
    let configured_secret = if is_release_build {
        env::var("LINECUT_PROJECT_BUILD_SECRET_V1")
            .ok()
            .or_else(read_local_release_secret)
    } else {
        None
    };
    if let Some(secret) = configured_secret.as_deref() {
        assert!(
            secret.len() >= 32,
            "LINECUT_PROJECT_BUILD_SECRET_V1 must contain at least 32 bytes"
        );
    } else if is_release_build {
        panic!(
            "official release builds require LINECUT_PROJECT_BUILD_SECRET_V1 or {LOCAL_RELEASE_SECRET_FILE}"
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

fn read_local_release_secret() -> Option<String> {
    let path = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR")?).join(LOCAL_RELEASE_SECRET_FILE);
    fs::read_to_string(path)
        .ok()
        .map(|secret| secret.trim_end_matches(['\r', '\n']).to_string())
        .filter(|secret| !secret.is_empty())
}

fn digest_with_context(context: &[u8], source: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(context);
    hasher.update(source);
    hasher.finalize().into()
}
