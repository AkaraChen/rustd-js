use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const WSTATE_BEGIN: u8 = 0;
const WSTATE_BEGIN_LINE: u8 = 1;
const WSTATE_CR: u8 = 2;
const WSTATE_DATA: u8 = 3;
const MAX_LINE: usize = 998;

struct SmtpSession {
    reader: BufReader<TcpStream>,
    closed: bool,
    data_state: u8,
    in_data: bool,
    line_len: usize,
}

static SESSIONS: OnceLock<Mutex<HashMap<u32, SmtpSession>>> = OnceLock::new();
static NEXT_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn sessions() -> &'static Mutex<HashMap<u32, SmtpSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn smtp_err(code: i32, command: &str, message: &str, kind: &str) -> Error {
    Error::from_reason(format!("smtp|{code}|{command}|{message}|{kind}"))
}

fn lock_session<T>(id: u32, f: impl FnOnce(&mut SmtpSession) -> Result<T>) -> Result<T> {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let session = map
        .get_mut(&id)
        .ok_or_else(|| smtp_err(0, "", "smtp: connection closed", "io"))?;
    if session.closed {
        return Err(smtp_err(0, "", "smtp: connection closed", "io"));
    }
    f(session)
}

impl SmtpSession {
    fn write_line(&mut self, line: &str) -> Result<()> {
        if self.in_data {
            self.finish_dot()?;
        }
        let stream = self.reader.get_mut();
        stream
            .write_all(line.as_bytes())
            .and_then(|_| {
                stream.write_all(b"\r\n")?;
                stream.flush()
            })
            .map_err(|e| smtp_err(0, "", &e.to_string(), "io"))
    }

    fn read_line(&mut self) -> Result<String> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| smtp_err(0, "", &e.to_string(), "io"))?;
        if n == 0 {
            return Err(smtp_err(0, "", "EOF", "io"));
        }
        if line.ends_with('\n') {
            line.pop();
        }
        if line.ends_with('\r') {
            line.pop();
        }
        Ok(line)
    }

    fn finish_dot(&mut self) -> Result<()> {
        if !self.in_data {
            return Ok(());
        }
        let stream = self.reader.get_mut();
        match self.data_state {
            WSTATE_BEGIN_LINE => {}
            WSTATE_CR => {
                stream
                    .write_all(b"\n")
                    .map_err(|e| smtp_err(0, "DATA", &e.to_string(), "io"))?;
            }
            _ => {
                stream
                    .write_all(b"\r\n")
                    .map_err(|e| smtp_err(0, "DATA", &e.to_string(), "io"))?;
            }
        }
        stream
            .write_all(b".\r\n")
            .and_then(|_| stream.flush())
            .map_err(|e| smtp_err(0, "DATA", &e.to_string(), "io"))?;
        self.in_data = false;
        self.data_state = WSTATE_BEGIN;
        self.line_len = 0;
        Ok(())
    }

    fn bump_line_len(&mut self) -> Result<()> {
        self.line_len += 1;
        if self.line_len > MAX_LINE {
            return Err(smtp_err(
                0,
                "DATA",
                "smtp: line exceeds RFC 5321 limit of 998 bytes",
                "protocol",
            ));
        }
        Ok(())
    }

    fn dot_write(&mut self, data: &[u8]) -> Result<()> {
        if !self.in_data {
            self.in_data = true;
            self.data_state = WSTATE_BEGIN;
            self.line_len = 0;
        }
        let mut out = Vec::with_capacity(data.len() + 8);
        for &c in data {
            match self.data_state {
                WSTATE_BEGIN | WSTATE_BEGIN_LINE => {
                    self.data_state = WSTATE_DATA;
                    self.line_len = 0;
                    if c == b'.' {
                        out.push(b'.');
                    }
                    if c == b'\r' {
                        self.data_state = WSTATE_CR;
                    } else if c == b'\n' {
                        out.push(b'\r');
                        self.data_state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                WSTATE_DATA => {
                    if c == b'\r' {
                        self.data_state = WSTATE_CR;
                    } else if c == b'\n' {
                        out.push(b'\r');
                        self.data_state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                WSTATE_CR => {
                    self.data_state = WSTATE_DATA;
                    if c == b'\n' {
                        self.data_state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                _ => {}
            }
            out.push(c);
        }
        let stream = self.reader.get_mut();
        stream
            .write_all(&out)
            .map_err(|e| smtp_err(0, "DATA", &e.to_string(), "io"))
    }
}

struct ParsedLine {
    code: i32,
    continued: bool,
    message: String,
    unmatched: bool,
}

fn parse_code_line(line: &str, expect_code: i32) -> Result<ParsedLine> {
    let bytes = line.as_bytes();
    if bytes.len() < 4 || (bytes[3] != b' ' && bytes[3] != b'-') {
        return Err(smtp_err(
            0,
            "",
            &format!("short response: {line}"),
            "protocol",
        ));
    }
    let continued = bytes[3] == b'-';
    let code: i32 = line[..3]
        .parse()
        .map_err(|_| smtp_err(0, "", &format!("invalid response code: {line}"), "protocol"))?;
    if code < 100 {
        return Err(smtp_err(
            0,
            "",
            &format!("invalid response code: {line}"),
            "protocol",
        ));
    }
    let message = line[4..].to_string();
    let unmatched = (1..10).contains(&expect_code) && code / 100 != expect_code
        || (10..100).contains(&expect_code) && code / 10 != expect_code
        || (100..1000).contains(&expect_code) && code != expect_code;
    Ok(ParsedLine {
        code,
        continued,
        message,
        unmatched,
    })
}

fn read_response(session: &mut SmtpSession, expect_code: i32) -> Result<(i32, String)> {
    let first_line = session.read_line()?;
    let first = parse_code_line(&first_line, expect_code)?;
    let code = first.code;
    let mut continued = first.continued;
    let multi = continued;
    let mut message = first.message;
    let unmatched = first.unmatched;
    while continued {
        let line = session.read_line()?;
        match parse_code_line(&line, 0) {
            Ok(parsed) if parsed.code == code => {
                continued = parsed.continued;
                message.push('\n');
                message.push_str(&parsed.message);
            }
            _ => {
                message.push('\n');
                message.push_str(line.trim_end_matches(['\r', '\n']));
                continued = true;
            }
        }
    }
    if unmatched {
        return Err(smtp_err(code, "", &message, "response"));
    }
    let _ = multi;
    Ok((code, message))
}

fn dial(addr: &str, timeout_ms: u32) -> Result<u32> {
    let stream =
        TcpStream::connect(addr).map_err(|e| smtp_err(0, "DIAL", &e.to_string(), "io"))?;
    if timeout_ms > 0 {
        let d = Duration::from_millis(timeout_ms as u64);
        let _ = stream.set_read_timeout(Some(d));
        let _ = stream.set_write_timeout(Some(d));
    }
    let _ = stream.set_nodelay(true);
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            id,
            SmtpSession {
                reader: BufReader::new(stream),
                closed: false,
                data_state: WSTATE_BEGIN,
                in_data: false,
                line_len: 0,
            },
        );
    Ok(id)
}

fn close_session(id: u32) -> Result<()> {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut session) = map.remove(&id) {
        session.closed = true;
        let _ = session.reader.get_mut().shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}

#[napi(object)]
pub struct SmtpNativeResponse {
    pub code: u32,
    pub message: String,
}

pub struct DialTask {
    pub addr: String,
    pub timeout_ms: u32,
}

impl Task for DialTask {
    type Output = u32;
    type JsValue = u32;
    fn compute(&mut self) -> Result<Self::Output> {
        dial(&self.addr, self.timeout_ms)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct WriteLineTask {
    pub id: u32,
    pub line: String,
}

impl Task for WriteLineTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<Self::Output> {
        lock_session(self.id, |s| s.write_line(&self.line))
    }
    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct ReadResponseTask {
    pub id: u32,
    pub expect: i32,
}

impl Task for ReadResponseTask {
    type Output = SmtpNativeResponse;
    type JsValue = SmtpNativeResponse;
    fn compute(&mut self) -> Result<Self::Output> {
        lock_session(self.id, |s| {
            let (code, message) = read_response(s, self.expect)?;
            Ok(SmtpNativeResponse {
                code: code as u32,
                message,
            })
        })
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct DotWriteTask {
    pub id: u32,
    pub data: Vec<u8>,
}

impl Task for DotWriteTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<Self::Output> {
        lock_session(self.id, |s| s.dot_write(&self.data))
    }
    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct DotCloseTask {
    pub id: u32,
}

impl Task for DotCloseTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<Self::Output> {
        lock_session(self.id, |s| s.finish_dot())
    }
    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct CloseTask {
    pub id: u32,
}

impl Task for CloseTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<Self::Output> {
        close_session(self.id)
    }
    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi(js_name = "smtpDial")]
pub fn smtp_dial(addr: String, timeout_ms: u32) -> AsyncTask<DialTask> {
    AsyncTask::new(DialTask { addr, timeout_ms })
}

#[napi(js_name = "smtpWriteLine")]
pub fn smtp_write_line(id: u32, line: String) -> AsyncTask<WriteLineTask> {
    AsyncTask::new(WriteLineTask { id, line })
}

#[napi(js_name = "smtpReadResponse")]
pub fn smtp_read_response(id: u32, expect: i32) -> AsyncTask<ReadResponseTask> {
    AsyncTask::new(ReadResponseTask { id, expect })
}

#[napi(js_name = "smtpDotWrite")]
pub fn smtp_dot_write(id: u32, data: Uint8Array) -> AsyncTask<DotWriteTask> {
    AsyncTask::new(DotWriteTask {
        id,
        data: data.to_vec(),
    })
}

#[napi(js_name = "smtpDotClose")]
pub fn smtp_dot_close(id: u32) -> AsyncTask<DotCloseTask> {
    AsyncTask::new(DotCloseTask { id })
}

#[napi(js_name = "smtpClose")]
pub fn smtp_close(id: u32) -> AsyncTask<CloseTask> {
    AsyncTask::new(CloseTask { id })
}
