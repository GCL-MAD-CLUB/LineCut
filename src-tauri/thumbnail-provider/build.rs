use std::{env, fs, path::PathBuf};

const CUSTOM_THUMBNAIL_PATH: &str = "assets/lcp-thumbnail.png";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn main() {
    println!("cargo:rerun-if-changed={CUSTOM_THUMBNAIL_PATH}");

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let source = manifest_dir.join(CUSTOM_THUMBNAIL_PATH);
    let image = match fs::read(&source) {
        Ok(image) => {
            assert!(
                image.starts_with(PNG_SIGNATURE),
                "{CUSTOM_THUMBNAIL_PATH} must be a PNG file"
            );
            image
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("failed to read {CUSTOM_THUMBNAIL_PATH}: {error}"),
    };

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set"))
        .join("lcp-thumbnail.png");
    fs::write(output, image).expect("failed to prepare the embedded LCP thumbnail");
}
