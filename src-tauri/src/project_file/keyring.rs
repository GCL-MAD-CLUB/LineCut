use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const ROOT_DERIVATION_SALT: &[u8] = b"LineCut/project-file/root-key/v1";
const ROOT_DERIVATION_INFO: &[u8] = b"LineCut sealed project root key";
const KEY_ID_CONTEXT: &[u8] = b"LineCut/project-file/key-id/v1";

// build.rs hashes the configured build secret and emits only split derived material. The original
// secret is never embedded as a string in the application binary.
include!(concat!(env!("OUT_DIR"), "/linecut_project_key.rs"));

pub(super) struct ApplicationKey {
    pub(super) id: [u8; 16],
    pub(super) material: Zeroizing<[u8; 32]>,
}

pub(super) fn current_key() -> Result<ApplicationKey, String> {
    derive_application_key()
}

pub(super) fn find_key(id: &[u8; 16]) -> Result<Option<ApplicationKey>, String> {
    // Add historical application keys here when rotating key material. The encrypted protocol and
    // content-version models remain unchanged; key IDs select the correct external key slot.
    let current = derive_application_key()?;
    Ok((current.id == *id).then_some(current))
}

fn derive_application_key() -> Result<ApplicationKey, String> {
    let input = Zeroizing::new(
        BUILD_KEY_MASK
            .iter()
            .zip(BUILD_KEY_MASKED)
            .map(|(left, right)| left ^ right)
            .collect::<Vec<_>>(),
    );

    let hkdf = Hkdf::<Sha256>::new(Some(ROOT_DERIVATION_SALT), input.as_slice());
    let mut material = Zeroizing::new([0u8; 32]);
    hkdf.expand(ROOT_DERIVATION_INFO, material.as_mut())
        .map_err(|_| "派生项目文件根密钥失败".to_string())?;

    let mut id_hasher = Sha256::new();
    id_hasher.update(KEY_ID_CONTEXT);
    id_hasher.update(material.as_slice());
    let digest = id_hasher.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);

    Ok(ApplicationKey { id, material })
}
