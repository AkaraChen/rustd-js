mod asn1;
mod csv;
mod pem;
mod xml;
mod xml_entities;
mod xml_names;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use csv::{CsvReader, CsvWriter};
use pem::{decode as pem_decode_bytes, encode as pem_encode_bytes, PemBlock};

#[napi(object)]
pub struct NativeCsvRow {
    pub fields: Vec<Uint8Array>,
    pub offset: i64,
}

#[napi(object)]
pub struct NativeCsvFieldPos {
    pub line: i32,
    pub column: i32,
}

#[napi]
pub struct NativeCsvReader {
    inner: CsvReader,
}

#[napi]
impl NativeCsvReader {
    #[napi(constructor)]
    pub fn new(
        data: Uint8Array,
        comma: u32,
        comment: u32,
        fields_per_record: i32,
        lazy_quotes: bool,
        trim_leading_space: bool,
    ) -> Self {
        Self {
            inner: CsvReader::new(
                data.to_vec(),
                comma,
                comment,
                fields_per_record,
                lazy_quotes,
                trim_leading_space,
            ),
        }
    }

    #[napi]
    pub fn read(&mut self) -> Result<Option<NativeCsvRow>> {
        match self.inner.read()? {
            None => Ok(None),
            Some(row) => Ok(Some(NativeCsvRow {
                fields: row.fields.into_iter().map(Uint8Array::from).collect(),
                offset: row.offset,
            })),
        }
    }

    #[napi]
    pub fn field_pos(&self, field: i32) -> Result<NativeCsvFieldPos> {
        let (line, column) = self.inner.field_pos(field)?;
        Ok(NativeCsvFieldPos { line, column })
    }

    #[napi]
    pub fn input_offset(&self) -> i64 {
        self.inner.input_offset()
    }
}

#[napi]
pub struct NativeCsvWriter {
    inner: CsvWriter,
}

#[napi]
impl NativeCsvWriter {
    #[napi(constructor)]
    pub fn new(comma: u32, use_crlf: bool) -> Self {
        Self {
            inner: CsvWriter::new(comma, use_crlf),
        }
    }

    #[napi]
    pub fn write(&mut self, fields: Vec<Uint8Array>) -> Result<()> {
        self.inner
            .write(fields.into_iter().map(|f| f.to_vec()).collect())
    }

    #[napi]
    pub fn bytes(&self) -> Uint8Array {
        self.inner.bytes().into()
    }

    #[napi]
    pub fn error_text(&self) -> Option<String> {
        self.inner.error_text()
    }
}

#[napi(object)]
pub struct NativePemResult {
    #[napi(js_name = "type")]
    pub typ: String,
    pub headers: HashMap<String, String>,
    pub bytes: Uint8Array,
    pub rest: Uint8Array,
}

#[napi]
pub fn pem_decode(data: Uint8Array) -> Option<NativePemResult> {
    let (block, rest) = pem_decode_bytes(data.as_ref())?;
    let mut headers = HashMap::new();
    for (k, v) in block.headers {
        headers.insert(k, v);
    }
    Some(NativePemResult {
        typ: block.type_name,
        headers,
        bytes: block.bytes.into(),
        rest: rest.into(),
    })
}

#[napi]
pub fn pem_encode(
    typ: String,
    headers: HashMap<String, String>,
    bytes: Uint8Array,
) -> Result<Uint8Array> {
    let block = PemBlock {
        type_name: typ,
        headers: headers.into_iter().collect(),
        bytes: bytes.to_vec(),
    };
    pem_encode_bytes(&block)
        .map(Uint8Array::from)
        .map_err(|e| Error::from_reason(format!("PemEncodeError:{e}")))
}

#[napi(object)]
pub struct NativeAsn1Result {
    pub value_json: String,
    pub rest: Uint8Array,
}

#[napi]
pub fn asn1_marshal(schema_json: String, value_json: String, params: Option<String>) -> Result<Uint8Array> {
    asn1::marshal(&schema_json, &value_json, params.as_deref()).map(Uint8Array::from)
}

#[napi]
pub fn asn1_unmarshal(
    data: Uint8Array,
    schema_json: String,
    params: Option<String>,
) -> Result<NativeAsn1Result> {
    let (value, rest) = asn1::unmarshal(data.as_ref(), &schema_json, params.as_deref())?;
    Ok(NativeAsn1Result {
        value_json: serde_json::to_string(&value)
            .map_err(|e| Error::from_reason(format!("Asn1StructuralError:{e}")))?,
        rest: rest.into(),
    })
}
