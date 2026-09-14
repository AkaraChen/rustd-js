use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

// Transport-only probe: replace this with the package's native implementation.
#[napi]
pub fn echo_bytes(data: Uint8Array) -> Uint8Array {
    data.to_vec().into()
}
