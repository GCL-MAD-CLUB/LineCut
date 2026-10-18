use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::keyring;
use crate::{app_error, AppError, AppResult, ErrorCode};

const MAGIC: &[u8; 8] = b"LCSEAL2\0";
const PROTOCOL_VERSION: u16 = 2;
const LEGACY_PROTOCOL_VERSION: u16 = 1;
const CIPHER_SUITE_XCHACHA20_POLY1305: u16 = 1;
const KDF_SUITE_HKDF_SHA256: u16 = 1;
const FLAGS: u32 = 0;
const HEADER_LEN: usize = 144;
const TAG_LEN: usize = 16;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const MAX_PLAINTEXT_LEN: usize = 512 * 1024 * 1024;
pub(super) const MAX_FILE_LEN: u64 = (HEADER_LEN + MAX_PLAINTEXT_LEN + TAG_LEN) as u64;

const OFFSET_PROTOCOL_VERSION: usize = 8;
const OFFSET_CONTENT_VERSION: usize = 10;
const OFFSET_CIPHER_SUITE: usize = 12;
const OFFSET_KDF_SUITE: usize = 14;
const OFFSET_FLAGS: usize = 16;
const OFFSET_HEADER_LEN: usize = 20;
const OFFSET_PLAINTEXT_LEN: usize = 24;
const OFFSET_CIPHERTEXT_LEN: usize = 32;
const OFFSET_KEY_ID: usize = 40;
const OFFSET_SALT: usize = 56;
const OFFSET_NONCE: usize = 88;
const OFFSET_RESERVED: usize = 112;

pub(super) struct OpenedProject {
    pub(super) content_version: u16,
    #[cfg(test)]
    pub(super) legacy_encryption: bool,
    pub(super) plaintext: Zeroizing<Vec<u8>>,
}

pub(super) fn recognizes(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

pub(super) fn seal(content_version: u16, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    seal_with_protocol(content_version, plaintext, PROTOCOL_VERSION)
}

fn seal_with_protocol(
    content_version: u16,
    plaintext: &[u8],
    protocol_version: u16,
) -> AppResult<Vec<u8>> {
    if content_version < 2 {
        return Err(app_error(
            ErrorCode::ProjectVersionUnsupported,
            "The encrypted project protocol requires content version 2 or newer",
        ));
    }
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(app_error(
            ErrorCode::ProjectEncodeFailed,
            "Project payload exceeds the encoding limit",
        ));
    }

    let application_key = if protocol_version == LEGACY_PROTOCOL_VERSION {
        keyring::derive_application_key(true)?
    } else {
        keyring::current_key()?
    };
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|error| {
        app_error(
            ErrorCode::ProjectRandomFailed,
            format!("Failed to generate the project encryption salt: {error}"),
        )
    })?;
    getrandom::getrandom(&mut nonce).map_err(|error| {
        app_error(
            ErrorCode::ProjectRandomFailed,
            format!("Failed to generate the project encryption nonce: {error}"),
        )
    })?;

    let ciphertext_len = plaintext.len().checked_add(TAG_LEN).ok_or_else(|| {
        app_error(
            ErrorCode::ProjectEncodeFailed,
            "Project payload length overflow",
        )
    })?;
    let header = build_header(
        protocol_version,
        content_version,
        plaintext.len(),
        ciphertext_len,
        &application_key.id,
        &salt,
        &nonce,
    );
    let file_key = derive_file_key(
        application_key.material.as_slice(),
        &salt,
        content_version,
        &application_key.id,
        protocol_version,
    )?;
    let cipher = XChaCha20Poly1305::new_from_slice(file_key.as_slice()).map_err(|_| {
        app_error(
            ErrorCode::ProjectEncryptionFailed,
            "Failed to initialize the project cipher",
        )
    })?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|_| {
            app_error(
                ErrorCode::ProjectEncryptionFailed,
                "Failed to encrypt the project payload",
            )
        })?;

    let mut output = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    output.extend_from_slice(&header);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub(super) fn open(bytes: &[u8]) -> AppResult<OpenedProject> {
    if bytes.len() < HEADER_LEN || !recognizes(bytes) {
        return Err(app_error(
            ErrorCode::ProjectFormatInvalid,
            "Input is not a recognized encrypted Locution Pro project file",
        ));
    }

    let protocol_version = read_u16(bytes, OFFSET_PROTOCOL_VERSION)?;
    let content_version = read_u16(bytes, OFFSET_CONTENT_VERSION)?;
    let cipher_suite = read_u16(bytes, OFFSET_CIPHER_SUITE)?;
    let kdf_suite = read_u16(bytes, OFFSET_KDF_SUITE)?;
    let flags = read_u32(bytes, OFFSET_FLAGS)?;
    let header_len = read_u32(bytes, OFFSET_HEADER_LEN)? as usize;
    let plaintext_len = read_u64(bytes, OFFSET_PLAINTEXT_LEN)?;
    let ciphertext_len = read_u64(bytes, OFFSET_CIPHERTEXT_LEN)?;

    if !matches!(protocol_version, PROTOCOL_VERSION | LEGACY_PROTOCOL_VERSION)
        || content_version < 2
        || cipher_suite != CIPHER_SUITE_XCHACHA20_POLY1305
        || kdf_suite != KDF_SUITE_HKDF_SHA256
        || flags != FLAGS
        || header_len != HEADER_LEN
        || bytes[OFFSET_RESERVED..HEADER_LEN]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(app_error(
            ErrorCode::ProjectVersionUnsupported,
            "The project encryption protocol is unsupported or its header is invalid",
        ));
    }
    if plaintext_len > MAX_PLAINTEXT_LEN as u64
        || ciphertext_len != plaintext_len + TAG_LEN as u64
        || ciphertext_len as usize != bytes.len() - HEADER_LEN
    {
        return Err(app_error(
            ErrorCode::ProjectIntegrityFailed,
            "The encrypted project length fields are inconsistent",
        ));
    }

    let mut key_id = [0u8; 16];
    key_id.copy_from_slice(&bytes[OFFSET_KEY_ID..OFFSET_SALT]);
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[OFFSET_SALT..OFFSET_NONCE]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[OFFSET_NONCE..OFFSET_RESERVED]);

    let application_key = keyring::find_key(&key_id)?.ok_or_else(authentication_error)?;
    let file_key = derive_file_key(
        application_key.material.as_slice(),
        &salt,
        content_version,
        &key_id,
        protocol_version,
    )?;
    let cipher = XChaCha20Poly1305::new_from_slice(file_key.as_slice())
        .map_err(|_| authentication_error())?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &bytes[HEADER_LEN..],
                aad: &bytes[..HEADER_LEN],
            },
        )
        .map_err(|_| authentication_error())?;
    if plaintext.len() != plaintext_len as usize {
        return Err(authentication_error());
    }

    Ok(OpenedProject {
        content_version,
        #[cfg(test)]
        legacy_encryption: protocol_version == LEGACY_PROTOCOL_VERSION,
        plaintext: Zeroizing::new(plaintext),
    })
}

fn build_header(
    protocol_version: u16,
    content_version: u16,
    plaintext_len: usize,
    ciphertext_len: usize,
    key_id: &[u8; 16],
    salt: &[u8; SALT_LEN],
    nonce: &[u8; NONCE_LEN],
) -> [u8; HEADER_LEN] {
    let mut header = [0u8; HEADER_LEN];
    header[..MAGIC.len()].copy_from_slice(MAGIC);
    header[OFFSET_PROTOCOL_VERSION..OFFSET_CONTENT_VERSION]
        .copy_from_slice(&protocol_version.to_le_bytes());
    header[OFFSET_CONTENT_VERSION..OFFSET_CIPHER_SUITE]
        .copy_from_slice(&content_version.to_le_bytes());
    header[OFFSET_CIPHER_SUITE..OFFSET_KDF_SUITE]
        .copy_from_slice(&CIPHER_SUITE_XCHACHA20_POLY1305.to_le_bytes());
    header[OFFSET_KDF_SUITE..OFFSET_FLAGS].copy_from_slice(&KDF_SUITE_HKDF_SHA256.to_le_bytes());
    header[OFFSET_FLAGS..OFFSET_HEADER_LEN].copy_from_slice(&FLAGS.to_le_bytes());
    header[OFFSET_HEADER_LEN..OFFSET_PLAINTEXT_LEN]
        .copy_from_slice(&(HEADER_LEN as u32).to_le_bytes());
    header[OFFSET_PLAINTEXT_LEN..OFFSET_CIPHERTEXT_LEN]
        .copy_from_slice(&(plaintext_len as u64).to_le_bytes());
    header[OFFSET_CIPHERTEXT_LEN..OFFSET_KEY_ID]
        .copy_from_slice(&(ciphertext_len as u64).to_le_bytes());
    header[OFFSET_KEY_ID..OFFSET_SALT].copy_from_slice(key_id);
    header[OFFSET_SALT..OFFSET_NONCE].copy_from_slice(salt);
    header[OFFSET_NONCE..OFFSET_RESERVED].copy_from_slice(nonce);
    header
}

fn derive_file_key(
    application_key: &[u8],
    salt: &[u8; SALT_LEN],
    content_version: u16,
    key_id: &[u8; 16],
    protocol_version: u16,
) -> AppResult<Zeroizing<[u8; 32]>> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), application_key);
    let mut info = Vec::with_capacity(52);
    info.extend_from_slice(if protocol_version == LEGACY_PROTOCOL_VERSION {
        b"LineCut/project-file/content-key"
    } else {
        b"LocutionPro/project-file/content-key"
    });
    info.extend_from_slice(&protocol_version.to_le_bytes());
    info.extend_from_slice(&content_version.to_le_bytes());
    info.extend_from_slice(key_id);
    let mut file_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(&info, file_key.as_mut()).map_err(|_| {
        app_error(
            ErrorCode::ProjectKeyDerivationFailed,
            "Failed to derive the project content key",
        )
    })?;
    Ok(file_key)
}

fn read_u16(bytes: &[u8], offset: usize) -> AppResult<u16> {
    Ok(u16::from_le_bytes(
        bytes[offset..offset + 2].try_into().map_err(|_| {
            app_error(
                ErrorCode::ProjectFormatInvalid,
                "Encrypted project header is truncated",
            )
        })?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> AppResult<u32> {
    Ok(u32::from_le_bytes(
        bytes[offset..offset + 4].try_into().map_err(|_| {
            app_error(
                ErrorCode::ProjectFormatInvalid,
                "Encrypted project header is truncated",
            )
        })?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> AppResult<u64> {
    Ok(u64::from_le_bytes(
        bytes[offset..offset + 8].try_into().map_err(|_| {
            app_error(
                ErrorCode::ProjectFormatInvalid,
                "Encrypted project header is truncated",
            )
        })?,
    ))
}

fn authentication_error() -> AppError {
    app_error(
        ErrorCode::ProjectAuthenticationFailed,
        "Project authentication failed because the payload is corrupted or the key identifier is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_saves_use_new_key_and_protocol_and_reject_tampering() {
        let bytes = seal(4, b"project data").unwrap();
        assert_eq!(read_u16(&bytes, OFFSET_PROTOCOL_VERSION).unwrap(), 2);
        assert_eq!(
            &bytes[OFFSET_KEY_ID..OFFSET_SALT],
            &keyring::current_key().unwrap().id
        );
        let opened = open(&bytes).unwrap();
        assert!(!opened.legacy_encryption);
        assert_eq!(opened.plaintext.as_slice(), b"project data");
        for index in [
            OFFSET_PROTOCOL_VERSION,
            OFFSET_KEY_ID,
            OFFSET_SALT,
            OFFSET_NONCE,
            HEADER_LEN,
        ] {
            let mut damaged = bytes.clone();
            damaged[index] ^= 1;
            assert!(open(&damaged).is_err());
        }
    }

    #[test]
    fn both_key_slots_open_legacy_files_but_resaving_uses_current_encryption() {
        let old_key = keyring::derive_application_key(true).unwrap();
        let new_key = keyring::current_key().unwrap();
        assert_ne!(old_key.id, new_key.id);
        assert!(keyring::find_key(&old_key.id).unwrap().is_some());
        assert!(keyring::find_key(&[0xff; 16]).unwrap().is_none());
        let old = seal_with_protocol(4, b"legacy project", LEGACY_PROTOCOL_VERSION).unwrap();
        let opened = open(&old).unwrap();
        assert!(opened.legacy_encryption);
        let new = seal(opened.content_version, opened.plaintext.as_slice()).unwrap();
        assert!(!open(&new).unwrap().legacy_encryption);
        assert_eq!(open(&new).unwrap().plaintext.as_slice(), b"legacy project");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn reads_an_independently_encoded_original_development_key_fixture() {
        // Fixed v1 protocol fixture, independent of this module's encoder and generated key slots.
        let hex = "4c435345414c320001000400010001000000000090000000160000000000000026000000000000002bb6ff04ef22bf87b0bb7edc7d2582b9000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f000102030405060708090a0b0c0d0e0f1011121314151617000000000000000000000000000000000000000000000000000000000000000059d2725c4379f69d148dfaf2358e3dc9a29b34e430b04578d5c5326880e14ba648189d2dbf40";
        let fixture: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let opened = open(&fixture).unwrap();
        assert!(opened.legacy_encryption);
        assert_eq!(opened.plaintext.as_slice(), b"legacy-project-fixture");
    }
}
