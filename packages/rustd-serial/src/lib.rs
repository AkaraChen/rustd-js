mod csv;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use csv::{CsvReader, CsvWriter};

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
