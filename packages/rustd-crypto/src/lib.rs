use hmac::{HmacReset, KeyInit};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use sha2::digest::{Digest, FixedOutput, Update};
use subtle::{Choice, ConstantTimeEq};

fn error(code: &str, message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("{code}: {message}"))
}

// Every variant holds only chaining state and a fixed-size partial block.
// Cloning snapshots that state; no message or original HMAC key is retained.
macro_rules! digest_states {
    ($($hash:ident, $mac:ident, $ty:ty, $name:literal);+ $(;)?) => {
        #[derive(Clone)]
        enum State { $($hash($ty), $mac(HmacReset<$ty>)),+ }
        impl State {
            fn new(algo: &str, key: Option<&[u8]>) -> Result<Self> {
                match (algo, key) {
                    $(($name, None) => Ok(Self::$hash(<$ty>::new())),
                      ($name, Some(key)) => Ok(Self::$mac(HmacReset::<$ty>::new_from_slice(key)
                          .map_err(|_| error("InvalidKeyLengthError", "crypto/hmac: invalid key length"))?)),)+
                    _ => Err(error("UnsupportedAlgorithmError", "crypto: unsupported hash algorithm")),
                }
            }
            fn update(&mut self, data: &[u8]) {
                match self { $(Self::$hash(s) => Update::update(s, data), Self::$mac(s) => Update::update(s, data)),+ }
            }
            fn finish(self) -> Vec<u8> {
                match self { $(Self::$hash(s) => s.finalize_fixed().to_vec(), Self::$mac(s) => s.finalize_fixed().to_vec()),+ }
            }
        }
    };
}
digest_states! {
    Md5, HmacMd5, md5::Md5, "md5";
    Sha1, HmacSha1, sha1::Sha1, "sha1";
    Sha224, HmacSha224, sha2::Sha224, "sha224";
    Sha256, HmacSha256, sha2::Sha256, "sha256";
    Sha384, HmacSha384, sha2::Sha384, "sha384";
    Sha512, HmacSha512, sha2::Sha512, "sha512";
    Sha512224, HmacSha512224, sha2::Sha512_224, "sha512-224";
    Sha512256, HmacSha512256, sha2::Sha512_256, "sha512-256";
}

#[napi]
pub struct NativeDigest {
    state: Option<State>,
    initial: State,
}

#[napi]
impl NativeDigest {
    #[napi(constructor)]
    pub fn new(algo: String, key: Option<Uint8Array>, allow_legacy: bool) -> Result<Self> {
        if matches!(algo.as_str(), "md5" | "sha1") && !allow_legacy {
            return Err(error(
                "InsecureAlgorithmError",
                "crypto: legacy algorithm requires allowLegacy",
            ));
        }
        let initial = State::new(&algo, key.as_ref().map(|k| k.as_ref()))?;
        Ok(Self {
            state: Some(initial.clone()),
            initial,
        })
    }

    #[napi]
    pub fn update(&mut self, data: Uint8Array) -> Result<()> {
        self.state
            .as_mut()
            .ok_or_else(finalized)?
            .update(data.as_ref());
        Ok(())
    }

    #[napi]
    pub fn sum(&self) -> Result<Uint8Array> {
        Ok(self
            .state
            .as_ref()
            .ok_or_else(finalized)?
            .clone()
            .finish()
            .into())
    }

    #[napi]
    pub fn digest(&mut self) -> Result<Uint8Array> {
        Ok(self.state.take().ok_or_else(finalized)?.finish().into())
    }

    #[napi]
    pub fn reset(&mut self) {
        self.state = Some(self.initial.clone());
    }

    #[napi]
    pub fn clone_state(&self) -> Result<Self> {
        Ok(Self {
            state: Some(self.state.as_ref().ok_or_else(finalized)?.clone()),
            initial: self.initial.clone(),
        })
    }
}

fn finalized() -> Error {
    error("HashFinalizedError", "crypto: hash already finalized")
}

#[napi]
pub fn hmac_equal(a: Uint8Array, b: Uint8Array) -> bool {
    // Lengths are public. Do not return early on a length or byte mismatch.
    let mut equal: Choice = a.len().ct_eq(&b.len());
    for (a, b) in a.iter().zip(b.iter()) {
        equal &= a.ct_eq(b);
    }
    bool::from(equal)
}
