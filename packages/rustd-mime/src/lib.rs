mod encodedword;
mod ext;
mod header;
mod mediatype;
mod qp;
mod reader;
mod writer;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::BTreeMap;

fn error(code: &str, message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("{code}: {message}"))
}

#[napi(object)]
pub struct MediaParam {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct ParseMediaTypeResult {
    pub media_type: String,
    pub params: Vec<MediaParam>,
    pub error: Option<String>,
}

#[napi]
pub fn parse_media_type(v: String) -> ParseMediaTypeResult {
    let parsed = mediatype::parse_media_type(&v);
    ParseMediaTypeResult {
        media_type: parsed.media_type,
        params: parsed
            .params
            .into_iter()
            .map(|(key, value)| MediaParam { key, value })
            .collect(),
        error: parsed.error,
    }
}

#[napi]
pub fn format_media_type(t: String, params: Vec<MediaParam>) -> String {
    let map: BTreeMap<String, String> = params.into_iter().map(|p| (p.key, p.value)).collect();
    mediatype::format_media_type(&t, &map)
}

#[napi]
pub fn type_by_extension(ext: String) -> String {
    ext::type_by_extension(&ext)
}

#[napi]
pub fn extensions_by_type(typ: String) -> Result<Vec<String>> {
    ext::extensions_by_type(&typ).map_err(|e| error("MediaTypeError", &e))
}

#[napi]
pub fn add_extension_type(ext: String, typ: String) -> Result<()> {
    ext::add_extension_type(&ext, &typ).map_err(|e| error("MediaTypeError", &e))
}

#[napi]
pub fn load_system_mime_types(paths: Option<Vec<String>>) -> u32 {
    ext::load_system_mime_types(paths)
}

#[napi(object)]
pub struct QpDecodeResult {
    pub data: Uint8Array,
    pub error: Option<String>,
}

#[napi]
pub fn qp_encode(data: Uint8Array, binary: bool) -> Result<Uint8Array> {
    qp::qp_encode(data.as_ref(), binary)
        .map(Into::into)
        .map_err(|e| error("QuotedPrintableError", e.message()))
}

#[napi]
pub fn qp_decode(data: Uint8Array) -> QpDecodeResult {
    let (data, error) = qp::qp_decode(data.as_ref());
    QpDecodeResult {
        data: data.into(),
        error,
    }
}

#[napi]
pub struct NativeQpReader {
    inner: qp::QpReader,
}

#[napi]
impl NativeQpReader {
    #[napi(constructor)]
    pub fn new(data: Uint8Array) -> Self {
        Self {
            inner: qp::QpReader::new(data.to_vec()),
        }
    }

    #[napi]
    pub fn read(&mut self, max_bytes: Option<u32>) -> Result<Uint8Array> {
        let max = max_bytes.map(|n| n as usize).unwrap_or(usize::MAX);
        match self.inner.read(max) {
            Ok(data) => Ok(data.into()),
            Err(qp::QpError::Eof) => Ok(Vec::new().into()),
            Err(e) => Err(error("QuotedPrintableError", e.message())),
        }
    }

    #[napi]
    pub fn end(&mut self) {
        self.inner.close();
    }
}

#[napi]
pub struct NativeQpWriter {
    inner: qp::QpWriter,
}

#[napi]
impl NativeQpWriter {
    #[napi(constructor)]
    pub fn new(binary: bool) -> Self {
        Self {
            inner: qp::QpWriter::new(binary),
        }
    }

    #[napi]
    pub fn write(&mut self, data: Uint8Array) -> Result<()> {
        self.inner
            .write(data.as_ref())
            .map_err(|e| error("QuotedPrintableError", e.message()))
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Uint8Array> {
        self.inner
            .finish()
            .map(Into::into)
            .map_err(|e| error("QuotedPrintableError", e.message()))
    }
}

#[napi]
pub fn encode_word(charset: String, s: String, enc: String) -> Result<String> {
    let kind = encodedword::WordEnc::from_str(&enc)
        .ok_or_else(|| error("MimeWordError", "mime: encoding must be b or q"))?;
    Ok(encodedword::encode_word(&charset, &s, kind))
}

#[napi(object)]
pub struct WordPart {
    pub text: Option<String>,
    pub charset: Option<String>,
    pub content: Option<Uint8Array>,
}

#[napi]
pub fn decode_word(word: String) -> Result<WordPart> {
    let part = encodedword::decode_word(&word).map_err(|e| error("MimeWordError", &e))?;
    Ok(WordPart {
        text: part.text,
        charset: part.charset,
        content: part.content.map(Into::into),
    })
}

#[napi]
pub fn canonical_mime_header_key(s: String) -> String {
    header::canonical_mime_header_key(&s)
}

#[napi]
pub fn decode_header_parts(header: String) -> Result<Vec<WordPart>> {
    encodedword::decode_header_parts(&header)
        .map(|parts| {
            parts
                .into_iter()
                .map(|part| WordPart {
                    text: part.text,
                    charset: part.charset,
                    content: part.content.map(Into::into),
                })
                .collect()
        })
        .map_err(|e| error("MimeWordError", &e))
}

#[napi]
pub struct NativeMultipartWriter {
    inner: writer::MultipartWriter,
}

#[napi]
impl NativeMultipartWriter {
    #[napi(constructor)]
    pub fn new(boundary: Option<String>) -> Result<Self> {
        writer::MultipartWriter::new(boundary)
            .map(|inner| Self { inner })
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn set_boundary(&mut self, boundary: String) -> Result<()> {
        self.inner
            .set_boundary(&boundary)
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn boundary(&self) -> String {
        self.inner.boundary().to_string()
    }

    #[napi]
    pub fn form_data_content_type(&self) -> String {
        self.inner.form_data_content_type()
    }

    #[napi]
    pub fn create_form_field(&mut self, fieldname: String) -> Result<u32> {
        self.inner
            .create_form_field(&fieldname)
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn create_form_file(&mut self, fieldname: String, filename: String) -> Result<u32> {
        self.inner
            .create_form_file(&fieldname, &filename)
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn write_part(&mut self, part_id: u32, data: Uint8Array) -> Result<()> {
        self.inner
            .write_part(part_id, data.as_ref())
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn end_part(&mut self, part_id: u32) -> Result<()> {
        self.inner
            .end_part(part_id)
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn write_field(&mut self, fieldname: String, value: String) -> Result<()> {
        self.inner
            .write_field(&fieldname, &value)
            .map_err(|e| error("MultipartError", &e))
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Uint8Array> {
        self.inner
            .finish()
            .map(Into::into)
            .map_err(|e| error("MultipartError", &e))
    }
}

#[napi]
pub fn file_content_disposition(fieldname: String, filename: String) -> String {
    writer::file_content_disposition(&fieldname, &filename)
}

#[napi(object)]
pub struct NativeHeaderField {
    pub key: String,
    pub values: Vec<String>,
}

#[napi(object)]
pub struct NativeMultipartPartData {
    pub header: Vec<NativeHeaderField>,
    pub form_name: String,
    pub file_name: String,
    pub body: Uint8Array,
}

#[napi]
pub struct NativeMultipartReader {
    inner: reader::MultipartReader,
}

#[napi]
impl NativeMultipartReader {
    #[napi(constructor)]
    pub fn new(boundary: String) -> Self {
        Self {
            inner: reader::MultipartReader::new(boundary),
        }
    }

    #[napi]
    pub fn write(&mut self, data: Uint8Array) {
        self.inner.write(data.as_ref());
    }

    #[napi]
    pub fn next_part(&mut self) -> Result<Option<NativeMultipartPartData>> {
        map_next_part(self.inner.next_part())
    }

    #[napi]
    pub fn next_raw_part(&mut self) -> Result<Option<NativeMultipartPartData>> {
        map_next_part(self.inner.next_raw_part())
    }
}

fn map_next_part(
    result: std::result::Result<Option<reader::MultipartPart>, String>,
) -> Result<Option<NativeMultipartPartData>> {
    match result {
        Ok(Some(part)) => Ok(Some(NativeMultipartPartData {
            header: part
                .header
                .into_iter()
                .map(|(key, values)| NativeHeaderField { key, values })
                .collect(),
            form_name: part.form_name,
            file_name: part.file_name,
            body: part.body.into(),
        })),
        Ok(None) => Ok(None),
        Err(e) if e.starts_with("quotedprintable:") => Err(error("QuotedPrintableError", &e)),
        Err(e) => Err(error("MultipartError", &e)),
    }
}
