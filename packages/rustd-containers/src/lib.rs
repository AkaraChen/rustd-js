mod codec;
mod sais;

use napi::bindgen_prelude::*;
use napi_derive::napi;

fn error(code: &str, message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("{code}: {message}"))
}

fn gone() -> Error {
    error("SuffixArrayDisposedError", "suffixarray: index has been disposed")
}

#[napi]
pub struct NativeSuffixArray {
    data: Option<Vec<u8>>,
    sa: Option<Vec<i32>>,
}

#[napi]
impl NativeSuffixArray {
    #[napi(factory)]
    pub fn build(data: Uint8Array) -> Result<Self> {
        let data = data.to_vec();
        if data.len() > i32::MAX as usize {
            return Err(error("SuffixArrayFormatError", "suffixarray: data too large"));
        }
        let mut sa = vec![0i32; data.len()];
        sais::text_32(&data, &mut sa);
        Ok(Self {
            data: Some(data),
            sa: Some(sa),
        })
    }

    #[napi(factory)]
    pub fn read(bytes: Uint8Array) -> Result<Self> {
        match codec::read_index(bytes.as_ref()) {
            Ok((data, sa)) => Ok(Self {
                data: Some(data),
                sa: Some(sa),
            }),
            Err(message) => Err(error("SuffixArrayFormatError", &message)),
        }
    }

    #[napi(getter)]
    pub fn length(&self) -> Result<u32> {
        Ok(self.data.as_ref().ok_or_else(gone)?.len() as u32)
    }

    #[napi]
    pub fn bytes(&self) -> Result<Uint8Array> {
        Ok(self.data.as_ref().ok_or_else(gone)?.clone().into())
    }

    #[napi]
    pub fn lookup(&self, query: Uint8Array, n: i64) -> Result<Uint32Array> {
        let data = self.data.as_ref().ok_or_else(gone)?;
        let sa = self.sa.as_ref().ok_or_else(gone)?;
        if n < -1 || n > i32::MAX as i64 {
            return Err(error(
                "SuffixArrayLookupError",
                "suffixarray: n must be -1 or a non-negative integer",
            ));
        }
        Ok(sais::lookup(data, sa, query.as_ref(), n as i32).into())
    }

    #[napi]
    pub fn write(&self) -> Result<Uint8Array> {
        let data = self.data.as_ref().ok_or_else(gone)?;
        let sa = self.sa.as_ref().ok_or_else(gone)?;
        Ok(codec::write_index(data, sa).into())
    }

    #[napi]
    pub fn dispose(&mut self) {
        self.data = None;
        self.sa = None;
    }
}
