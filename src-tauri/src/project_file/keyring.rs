use crate::{app_error, AppResult, ErrorCode};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const ROOT_DERIVATION_SALT: &[u8] = b"LocutionPro/project-file/root-key/v1";
const ROOT_DERIVATION_INFO: &[u8] = b"LocutionPro sealed project root key";
const KEY_ID_CONTEXT: &[u8] = b"LocutionPro/project-file/key-id/v1";

// build.rs hashes the configured build secret and emits only split derived material. The original
// secret is never embedded as a string in the application binary.
include!(concat!(env!("OUT_DIR"), "/locution_pro_project_key.rs"));

pub(super) struct ApplicationKey {
    pub(super) id: [u8; 16],
    pub(super) material: Zeroizing<[u8; 32]>,
}

pub(super) fn current_key() -> AppResult<ApplicationKey> {
    derive_application_key(false)
}

pub(super) fn find_key(id: &[u8; 16]) -> AppResult<Option<ApplicationKey>> {
    let current = derive_application_key(false)?;
    if current.id == *id {
        return Ok(Some(current));
    }
    let legacy = derive_application_key(true)?;
    Ok((legacy.id == *id).then_some(legacy))
}

pub(super) fn derive_application_key(legacy: bool) -> AppResult<ApplicationKey> {
    let (mask, masked, salt, info, id_context) = if legacy {
        (
            LEGACY_BUILD_KEY_MASK,
            LEGACY_BUILD_KEY_MASKED,
            b"LineCut/project-file/root-key/v1".as_slice(),
            b"LineCut sealed project root key".as_slice(),
            b"LineCut/project-file/key-id/v1".as_slice(),
        )
    } else {
        (
            BUILD_KEY_MASK,
            BUILD_KEY_MASKED,
            ROOT_DERIVATION_SALT,
            ROOT_DERIVATION_INFO,
            KEY_ID_CONTEXT,
        )
    };
    let input = Zeroizing::new(
        mask.iter()
            .zip(masked)
            .map(|(left, right)| left ^ right)
            .collect::<Vec<_>>(),
    );

    let hkdf = Hkdf::<Sha256>::new(Some(salt), input.as_slice());
    let mut material = Zeroizing::new([0u8; 32]);
    hkdf.expand(info, material.as_mut()).map_err(|_| {
        app_error(
            ErrorCode::ProjectKeyDerivationFailed,
            "Failed to derive the project root key",
        )
    })?;

    let mut id_hasher = Sha256::new();
    id_hasher.update(id_context);
    id_hasher.update(material.as_slice());
    let digest = id_hasher.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);

    Ok(ApplicationKey { id, material })
}
