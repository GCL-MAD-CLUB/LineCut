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
const PROTOCOL_VERSION: u16 = 1;
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
    pub(super) plaintext: Zeroizing<Vec<u8>>,
}

pub(super) fn recognizes(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

pub(super) fn seal(content_version: u16, plaintext: &[u8]) -> AppResult<Vec<u8>> {
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

    let application_key = keyring::current_key()?;
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
            "Input is not a recognized encrypted LineCut project file",
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

    if protocol_version != PROTOCOL_VERSION
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
        plaintext: Zeroizing::new(plaintext),
    })
}

fn build_header(
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
        .copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
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
) -> AppResult<Zeroizing<[u8; 32]>> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), application_key);
    let mut info = Vec::with_capacity(52);
    info.extend_from_slice(b"LineCut/project-file/content-key");
    info.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
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
