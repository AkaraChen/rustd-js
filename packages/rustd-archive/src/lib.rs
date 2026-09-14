use napi::bindgen_prelude::*;
use napi_derive::napi;

mod error;
mod tar;
mod zip;

fn throw(err: error::FormatError) -> Error {
    Error::new(Status::InvalidArg, err.to_string())
}

#[napi(object)]
pub struct NativeEntry {
    pub json: String,
    pub data: Uint8Array,
}

fn decode_tar(entries: Vec<NativeEntry>) -> std::result::Result<Vec<tar::Entry>, Error> {
    entries
        .into_iter()
        .map(|e| {
            let mut item: tar::Entry = serde_json::from_str(&e.json)
                .map_err(|err| Error::new(Status::InvalidArg, format!("TarFormatError: {err} @ 0")))?;
            item.data = e.data.to_vec();
            if item.size == 0 {
                item.size = item.data.len() as u64;
            }
            Ok(item)
        })
        .collect()
}

fn encode_tar(entries: Vec<tar::Entry>) -> Vec<NativeEntry> {
    entries
        .into_iter()
        .map(|e| NativeEntry {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
            data: e.data.into(),
        })
        .collect()
}

fn decode_zip(entries: Vec<NativeEntry>) -> std::result::Result<Vec<zip::Entry>, Error> {
    entries
        .into_iter()
        .map(|e| {
            let mut item: zip::Entry = serde_json::from_str(&e.json)
                .map_err(|err| Error::new(Status::InvalidArg, format!("ZipFormatError: {err} @ 0")))?;
            item.data = e.data.to_vec();
            if item.size == 0 {
                item.size = item.data.len() as u64;
            }
            Ok(item)
        })
        .collect()
}

fn encode_zip(entries: Vec<zip::Entry>) -> Vec<NativeEntry> {
    entries
        .into_iter()
        .map(|e| NativeEntry {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
            data: e.data.into(),
        })
        .collect()
}

#[napi]
pub fn tar_create(entries: Vec<NativeEntry>) -> Result<Uint8Array> {
    let items = decode_tar(entries)?;
    tar::create(&items).map(|b| b.into()).map_err(throw)
}

#[napi]
pub fn tar_extract(buf: Uint8Array) -> Result<Vec<NativeEntry>> {
    tar::extract(buf.as_ref()).map(encode_tar).map_err(throw)
}

#[napi]
pub fn zip_create(entries: Vec<NativeEntry>) -> Result<Uint8Array> {
    let items = decode_zip(entries)?;
    zip::create(&items).map(|b| b.into()).map_err(throw)
}

#[napi]
pub fn zip_extract(buf: Uint8Array) -> Result<Vec<NativeEntry>> {
    zip::extract(buf.as_ref()).map(encode_zip).map_err(throw)
}

#[napi]
pub struct NativeTarWriter {
    inner: tar::Writer,
}

#[napi]
impl NativeTarWriter {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: tar::Writer::new() }
    }

    #[napi]
    pub fn write_header(&mut self, entry: NativeEntry) -> Result<()> {
        let items = decode_tar(vec![entry])?;
        self.inner.write_header(items.into_iter().next().unwrap()).map_err(throw)
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<()> {
        self.inner.write(chunk.as_ref()).map_err(throw)
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Uint8Array> {
        self.inner.finish().map(|b| b.into()).map_err(throw)
    }
}

#[napi]
pub struct NativeTarReader {
    inner: tar::Reader,
}

#[napi]
impl NativeTarReader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: tar::Reader::new() }
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<Vec<NativeEntry>> {
        self.inner.write(chunk.as_ref()).map(encode_tar).map_err(throw)
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Vec<NativeEntry>> {
        self.inner.finish().map(encode_tar).map_err(throw)
    }
}

#[napi]
pub struct NativeZipWriter {
    inner: zip::Writer,
}

#[napi]
impl NativeZipWriter {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: zip::Writer::new() }
    }

    #[napi]
    pub fn write_header(&mut self, entry: NativeEntry) -> Result<()> {
        let items = decode_zip(vec![entry])?;
        self.inner.write_header(items.into_iter().next().unwrap()).map_err(throw)
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<()> {
        self.inner.write(chunk.as_ref()).map_err(throw)
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Uint8Array> {
        self.inner.finish().map(|b| b.into()).map_err(throw)
    }
}

#[napi]
pub struct NativeZipReader {
    inner: zip::Reader,
}

#[napi]
impl NativeZipReader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: zip::Reader::new() }
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) {
        self.inner.write(chunk.as_ref());
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Vec<NativeEntry>> {
        self.inner.finish().map(encode_zip).map_err(throw)
    }
}
