use std::fmt;

#[derive(Debug)]
pub struct FormatError {
    pub kind: Kind,
    pub message: String,
    pub offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Tar,
    Zip,
}

impl FormatError {
    pub fn tar(offset: u64, message: impl Into<String>) -> Self {
        Self { kind: Kind::Tar, message: message.into(), offset }
    }
    pub fn zip(offset: u64, message: impl Into<String>) -> Self {
        Self { kind: Kind::Zip, message: message.into(), offset }
    }
    pub fn code(&self) -> &'static str {
        match self.kind {
            Kind::Tar => "TarFormatError",
            Kind::Zip => "ZipFormatError",
        }
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} @ {}", self.code(), self.message, self.offset)
    }
}

impl std::error::Error for FormatError {}

pub type Result<T> = std::result::Result<T, FormatError>;
