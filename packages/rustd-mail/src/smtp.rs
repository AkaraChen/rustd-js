use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const WSTATE_BEGIN: u8 = 0;
const WSTATE_BEGIN_LINE: u8 = 1;
const WSTATE_CR: u8 = 2;
const WSTATE_DATA: u8 = 3;
const MAX_LINE: usize = 998;

struct DotStuffer {
    state: u8,
    line_len: usize,
}

impl DotStuffer {
    fn new() -> Self {
        Self {
            state: WSTATE_BEGIN,
            line_len: 0,
        }
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

    fn write(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(data.len() + 8);
        for &c in data {
            match self.state {
                WSTATE_BEGIN | WSTATE_BEGIN_LINE => {
                    self.state = WSTATE_DATA;
                    self.line_len = 0;
                    if c == b'.' {
                        out.push(b'.');
                    }
                    if c == b'\r' {
                        self.state = WSTATE_CR;
                    } else if c == b'\n' {
                        out.push(b'\r');
                        self.state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                WSTATE_DATA => {
                    if c == b'\r' {
                        self.state = WSTATE_CR;
                    } else if c == b'\n' {
                        out.push(b'\r');
                        self.state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                WSTATE_CR => {
                    self.state = WSTATE_DATA;
                    if c == b'\n' {
                        self.state = WSTATE_BEGIN_LINE;
                        self.line_len = 0;
                    } else {
                        self.bump_line_len()?;
                    }
                }
                _ => {}
            }
            out.push(c);
        }
        Ok(out)
    }

    fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5);
        match self.state {
            WSTATE_BEGIN_LINE => {}
            WSTATE_CR => out.push(b'\n'),
            _ => out.extend_from_slice(b"\r\n"),
        }
        out.extend_from_slice(b".\r\n");
        self.state = WSTATE_BEGIN;
        self.line_len = 0;
        out
    }
}

struct SmtpSession {
    stream: TcpStream,
    buf: Vec<u8>,
    closed: bool,
    stuffer: DotStuffer,
    in_data: bool,
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
        self.stream
            .write_all(line.as_bytes())
            .and_then(|_| {
                self.stream.write_all(b"\r\n")?;
                self.stream.flush()
            })
            .map_err(|e| smtp_err(0, "", &e.to_string(), "io"))
    }

    fn read_line(&mut self) -> Result<String> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let mut line = self.buf.drain(..=pos).collect::<Vec<u8>>();
                if line.ends_with(&[b'\n']) {
                    line.pop();
                }
                if line.ends_with(&[b'\r']) {
                    line.pop();
                }
                return String::from_utf8(line)
                    .map_err(|_| smtp_err(0, "", "smtp: invalid UTF-8 in response", "protocol"));
            }
            let mut tmp = [0u8; 4096];
            let n = self
                .stream
                .read(&mut tmp)
                .map_err(|e| smtp_err(0, "", &e.to_string(), "io"))?;
            if n == 0 {
                return Err(smtp_err(0, "", "EOF", "io"));
            }
            self.buf.extend_from_slice(&tmp[..n]);
        }
    }

    fn finish_dot(&mut self) -> Result<()> {
        if !self.in_data {
            return Ok(());
        }
        let out = self.stuffer.finish();
        self.stream
            .write_all(&out)
            .and_then(|_| self.stream.flush())
            .map_err(|e| smtp_err(0, "DATA", &e.to_string(), "io"))?;
        self.in_data = false;
        Ok(())
    }

    fn dot_write(&mut self, data: &[u8]) -> Result<()> {
        if !self.in_data {
            self.in_data = true;
            self.stuffer = DotStuffer::new();
        }
        let out = self.stuffer.write(data)?;
        self.stream
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
                stream,
                buf: Vec::new(),
                closed: false,
                stuffer: DotStuffer::new(),
                in_data: false,
            },
        );
    Ok(id)
}

fn close_session(id: u32) -> Result<()> {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut session) = map.remove(&id) {
        session.closed = true;
        let _ = session.stream.shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}

fn take_fd(id: u32) -> Result<(i64, Vec<u8>)> {
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    if map.get(&id).is_some_and(|s| s.in_data) {
        return Err(smtp_err(
            0,
            "STARTTLS",
            "smtp: STARTTLS during DATA",
            "protocol",
        ));
    }
    let session = map
        .remove(&id)
        .ok_or_else(|| smtp_err(0, "STARTTLS", "smtp: connection closed", "io"))?;
    let SmtpSession {
        stream,
        buf: leftover,
        ..
    } = session;
    let _ = stream.set_nonblocking(true);
    let fd = {
        #[cfg(unix)]
        {
            use std::os::fd::IntoRawFd;
            stream.into_raw_fd() as i64
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::IntoRawSocket;
            stream.into_raw_socket() as i64
        }
    };
    Ok((fd, leftover))
}

#[napi(object)]
pub struct SmtpNativeResponse {
    pub code: u32,
    pub message: String,
}

#[napi(object)]
pub struct SmtpTakeFdResult {
    pub fd: i64,
    pub leftover: Uint8Array,
}

#[napi(object)]
pub struct SmtpDotStuffResult {
    pub output: Uint8Array,
    pub state: u32,
    pub line_len: u32,
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

pub struct TakeFdTask {
    pub id: u32,
}

impl Task for TakeFdTask {
    type Output = (i64, Vec<u8>);
    type JsValue = SmtpTakeFdResult;
    fn compute(&mut self) -> Result<Self::Output> {
        take_fd(self.id)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(SmtpTakeFdResult {
            fd: output.0,
            leftover: output.1.into(),
        })
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

#[napi(js_name = "smtpTakeFd")]
pub fn smtp_take_fd(id: u32) -> AsyncTask<TakeFdTask> {
    AsyncTask::new(TakeFdTask { id })
}

#[napi(js_name = "smtpDotStuff")]
pub fn smtp_dot_stuff(state: u32, line_len: u32, data: Uint8Array) -> Result<SmtpDotStuffResult> {
    let mut stuffer = DotStuffer {
        state: state as u8,
        line_len: line_len as usize,
    };
    let output = stuffer.write(data.as_ref())?;
    Ok(SmtpDotStuffResult {
        output: output.into(),
        state: stuffer.state as u32,
        line_len: stuffer.line_len as u32,
    })
}

#[napi(js_name = "smtpDotFinish")]
pub fn smtp_dot_finish(state: u32) -> Uint8Array {
    let mut stuffer = DotStuffer {
        state: state as u8,
        line_len: 0,
    };
    stuffer.finish().into()
}
