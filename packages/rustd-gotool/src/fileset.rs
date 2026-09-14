use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

use crate::unicode_go::is_upper;

#[derive(Clone)]
struct LineInfo {
    offset: i32,
    filename: String,
    line: i32,
    column: i32,
}

struct FileData {
    name: String,
    base: i32,
    size: i32,
    lines: Vec<i32>,
    infos: Vec<LineInfo>,
}

struct FileSetData {
    base: i32,
    files: Vec<Arc<Mutex<FileData>>>,
}

fn poison() -> Error {
    Error::new(Status::GenericFailure, "gotool: file set lock poisoned")
}

fn lock<'a, T>(m: &'a Mutex<T>) -> Result<std::sync::MutexGuard<'a, T>> {
    m.lock().map_err(|_| poison())
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct GoPosition {
    pub filename: String,
    pub offset: i64,
    pub line: i64,
    pub column: i64,
}

#[napi]
pub struct FileSet {
    inner: Arc<Mutex<FileSetData>>,
}

#[napi]
pub struct GoFile {
    file: Arc<Mutex<FileData>>,
}

impl GoFile {
    pub(crate) fn clone_handle(&self) -> Self {
        Self {
            file: Arc::clone(&self.file),
        }
    }

    pub(crate) fn inner_size(&self) -> Result<i32> {
        Ok(lock(&self.file)?.size)
    }

    pub(crate) fn inner_name(&self) -> Result<String> {
        Ok(lock(&self.file)?.name.clone())
    }

    pub(crate) fn add_line_offset(&self, offset: i32) -> Result<()> {
        let mut f = lock(&self.file)?;
        let i = f.lines.len();
        if (i == 0 || f.lines[i - 1] < offset) && offset < f.size {
            f.lines.push(offset);
        }
        Ok(())
    }

    pub(crate) fn add_line_column_info(
        &self,
        offset: i32,
        filename: String,
        line: i32,
        column: i32,
    ) -> Result<()> {
        let mut f = lock(&self.file)?;
        let i = f.infos.len();
        if (i == 0 || f.infos[i - 1].offset < offset) && offset < f.size {
            f.infos.push(LineInfo {
                offset,
                filename,
                line,
                column,
            });
        }
        Ok(())
    }

    pub(crate) fn pos_of(&self, offset: i32) -> Result<i32> {
        let f = lock(&self.file)?;
        Ok(f.base + fix_offset(offset, f.size))
    }

    pub(crate) fn offset_of(&self, p: i32) -> Result<i32> {
        let f = lock(&self.file)?;
        Ok(fix_offset(p - f.base, f.size))
    }

    pub(crate) fn position_of(&self, p: i32, adjusted: bool) -> Result<GoPosition> {
        if p == 0 {
            return Ok(GoPosition::default());
        }
        let f = lock(&self.file)?;
        let offset = fix_offset(p - f.base, f.size);
        let (filename, line, column) = unpack(&f, offset, adjusted);
        Ok(GoPosition {
            filename,
            offset: i64::from(offset),
            line: i64::from(line),
            column: i64::from(column),
        })
    }
}

#[napi]
impl FileSet {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FileSetData {
                base: 1,
                files: Vec::new(),
            })),
        }
    }

    #[napi]
    pub fn base(&self) -> Result<i64> {
        Ok(i64::from(lock(&self.inner)?.base))
    }

    #[napi]
    pub fn add_file(&self, filename: String, base: i64, size: i64) -> Result<GoFile> {
        if size < 0 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("gotool: invalid size {size} (should be >= 0)"),
            ));
        }
        if size > i64::from(i32::MAX) {
            return Err(Error::new(
                Status::InvalidArg,
                "gotool: file size exceeds 2GiB FileSet interval",
            ));
        }
        let mut set = lock(&self.inner)?;
        let mut base = base;
        if base < 0 {
            base = i64::from(set.base);
        }
        if base < i64::from(set.base) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("gotool: invalid base {base} (should be >= {})", set.base),
            ));
        }
        if base > i64::from(i32::MAX) {
            return Err(Error::new(
                Status::InvalidArg,
                "gotool: token.Pos offset overflow (> 2G of source code in file set)",
            ));
        }
        let next = base
            .checked_add(size)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "gotool: token.Pos offset overflow (> 2G of source code in file set)",
                )
            })?;
        if next > i64::from(i32::MAX) {
            return Err(Error::new(
                Status::InvalidArg,
                "gotool: token.Pos offset overflow (> 2G of source code in file set)",
            ));
        }
        let data = Arc::new(Mutex::new(FileData {
            name: filename,
            base: base as i32,
            size: size as i32,
            lines: vec![0],
            infos: Vec::new(),
        }));
        set.base = next as i32;
        set.files.push(Arc::clone(&data));
        Ok(GoFile { file: data })
    }

    #[napi]
    pub fn file_count(&self) -> Result<u32> {
        Ok(lock(&self.inner)?.files.len() as u32)
    }

    #[napi]
    pub fn file_at(&self, index: u32) -> Result<Option<GoFile>> {
        let set = lock(&self.inner)?;
        Ok(set
            .files
            .get(index as usize)
            .map(|f| GoFile { file: Arc::clone(f) }))
    }

    #[napi]
    pub fn position(&self, pos: i64) -> Result<GoPosition> {
        self.position_for(pos, true)
    }

    #[napi]
    pub fn position_for(&self, pos: i64, adjusted: bool) -> Result<GoPosition> {
        if pos == 0 {
            return Ok(GoPosition::default());
        }
        let p = clamp_pos(pos);
        let set = lock(&self.inner)?;
        if let Some(file) = find_file(&set, p) {
            let f = lock(file)?;
            let offset = fix_offset(p - f.base, f.size);
            let (filename, line, column) = unpack(&f, offset, adjusted);
            return Ok(GoPosition {
                filename,
                offset: i64::from(offset),
                line: i64::from(line),
                column: i64::from(column),
            });
        }
        Ok(GoPosition::default())
    }
}

#[napi]
impl GoFile {
    #[napi]
    pub fn name(&self) -> Result<String> {
        self.inner_name()
    }

    #[napi]
    pub fn base(&self) -> Result<i64> {
        Ok(i64::from(lock(&self.file)?.base))
    }

    #[napi]
    pub fn size(&self) -> Result<i64> {
        Ok(i64::from(lock(&self.file)?.size))
    }

    #[napi]
    pub fn line_count(&self) -> Result<i64> {
        Ok(lock(&self.file)?.lines.len() as i64)
    }

    #[napi]
    pub fn line_start(&self, line: i64) -> Result<i64> {
        if line < 1 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("gotool: invalid line number {line} (should be >= 1)"),
            ));
        }
        let f = lock(&self.file)?;
        if line > f.lines.len() as i64 {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "gotool: invalid line number {line} (should be < {})",
                    f.lines.len()
                ),
            ));
        }
        Ok(i64::from(f.base + f.lines[line as usize - 1]))
    }

    #[napi]
    pub fn offset(&self, p: i64) -> Result<i64> {
        Ok(i64::from(self.offset_of(clamp_pos(p))?))
    }

    #[napi]
    pub fn position(&self, p: i64) -> Result<GoPosition> {
        self.position_of(clamp_pos(p), true)
    }

    #[napi]
    pub fn position_for(&self, p: i64, adjusted: bool) -> Result<GoPosition> {
        self.position_of(clamp_pos(p), adjusted)
    }

    #[napi]
    pub fn add_line(&self, offset: i64) -> Result<()> {
        self.add_line_offset(clamp_i32(offset))
    }

    #[napi]
    pub fn merge_line(&self, line: i64) -> Result<()> {
        if line < 1 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("gotool: invalid line number {line} (should be >= 1)"),
            ));
        }
        let mut f = lock(&self.file)?;
        if line >= f.lines.len() as i64 {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "gotool: invalid line number {line} (should be < {})",
                    f.lines.len()
                ),
            ));
        }
        let idx = line as usize;
        f.lines.remove(idx);
        Ok(())
    }

    #[napi]
    pub fn set_lines(&self, lines: Vec<i64>) -> Result<()> {
        let mut converted = Vec::with_capacity(lines.len());
        {
            let f = lock(&self.file)?;
            for (i, offset) in lines.iter().enumerate() {
                let offset = clamp_i32(*offset);
                if i > 0 && offset <= converted[i - 1] || f.size <= offset {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "gotool: invalid line table",
                    ));
                }
                converted.push(offset);
            }
        }
        lock(&self.file)?.lines = converted;
        Ok(())
    }

    #[napi]
    pub fn lines(&self) -> Result<Vec<i64>> {
        Ok(lock(&self.file)?
            .lines
            .iter()
            .copied()
            .map(i64::from)
            .collect())
    }
}

fn clamp_pos(pos: i64) -> i32 {
    pos.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn clamp_i32(v: i64) -> i32 {
    v.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn fix_offset(offset: i32, size: i32) -> i32 {
    if offset < 0 {
        0
    } else if offset > size {
        size
    } else {
        offset
    }
}

fn search_ints(a: &[i32], x: i32) -> i32 {
    let mut i = 0i32;
    let mut j = a.len() as i32;
    while i < j {
        let h = ((i as u32 + j as u32) >> 1) as i32;
        if a[h as usize] <= x {
            i = h + 1;
        } else {
            j = h;
        }
    }
    i - 1
}

fn search_line_infos(a: &[LineInfo], x: i32) -> i32 {
    let mut lo = 0i32;
    let mut hi = a.len() as i32;
    while lo < hi {
        let m = lo + (hi - lo) / 2;
        match a[m as usize].offset.cmp(&x) {
            std::cmp::Ordering::Less => lo = m + 1,
            std::cmp::Ordering::Greater => hi = m,
            std::cmp::Ordering::Equal => return m,
        }
    }
    lo - 1
}

fn unpack(f: &FileData, offset: i32, adjusted: bool) -> (String, i32, i32) {
    let mut filename = f.name.clone();
    let mut line = 0i32;
    let mut column = 0i32;
    let i = search_ints(&f.lines, offset);
    if i >= 0 {
        line = i + 1;
        column = offset - f.lines[i as usize] + 1;
    }
    if adjusted && !f.infos.is_empty() {
        let i_info = search_line_infos(&f.infos, offset);
        if i_info >= 0 {
            let alt = &f.infos[i_info as usize];
            filename = alt.filename.clone();
            let i_line = search_ints(&f.lines, alt.offset);
            if i_line >= 0 {
                let d = line - (i_line + 1);
                line = alt.line + d;
                if alt.column == 0 {
                    column = 0;
                } else if d == 0 {
                    column = alt.column + (offset - alt.offset);
                }
            }
        }
    }
    (filename, line, column)
}

fn find_file(set: &FileSetData, p: i32) -> Option<&Arc<Mutex<FileData>>> {
    if set.files.is_empty() {
        return None;
    }
    let mut lo = 0i32;
    let mut hi = set.files.len() as i32;
    while lo < hi {
        let m = lo + (hi - lo) / 2;
        let base = lock_base(&set.files[m as usize]);
        match base.cmp(&p) {
            std::cmp::Ordering::Less => lo = m + 1,
            std::cmp::Ordering::Greater => hi = m,
            std::cmp::Ordering::Equal => {
                lo = m + 1;
                break;
            }
        }
    }
    let i = lo - 1;
    if i < 0 {
        return None;
    }
    let f = &set.files[i as usize];
    let (base, size) = {
        let g = f.lock().ok()?;
        (g.base, g.size)
    };
    if p <= base + size {
        Some(f)
    } else {
        None
    }
}

fn lock_base(f: &Mutex<FileData>) -> i32 {
    f.lock().map(|g| g.base).unwrap_or(i32::MAX)
}

pub fn is_exported(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(ch) => is_upper(ch as u32),
        None => false,
    }
}

/// Slash-separated Clean matching Go `path.Clean` / Unix `filepath.Clean`.
pub fn path_clean(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let rooted = path.as_bytes()[0] == b'/';
    let n = path.len();
    let bytes = path.as_bytes();
    let mut buf = Vec::with_capacity(n);
    let mut r = 0usize;
    let mut dotdot = 0usize;
    if rooted {
        buf.push(b'/');
        r = 1;
        dotdot = 1;
    }
    while r < n {
        if bytes[r] == b'/' {
            r += 1;
        } else if bytes[r] == b'.' && (r + 1 == n || bytes[r + 1] == b'/') {
            r += 1;
        } else if bytes[r] == b'.'
            && r + 1 < n
            && bytes[r + 1] == b'.'
            && (r + 2 == n || bytes[r + 2] == b'/')
        {
            r += 2;
            if buf.len() > dotdot {
                buf.pop();
                while buf.len() > dotdot && buf[buf.len() - 1] != b'/' {
                    buf.pop();
                }
            } else if !rooted {
                if !buf.is_empty() {
                    buf.push(b'/');
                }
                buf.push(b'.');
                buf.push(b'.');
                dotdot = buf.len();
            }
        } else {
            if rooted && buf.len() != 1 || !rooted && !buf.is_empty() {
                buf.push(b'/');
            }
            while r < n && bytes[r] != b'/' {
                buf.push(bytes[r]);
                r += 1;
            }
        }
    }
    if buf.is_empty() {
        return ".".into();
    }
    String::from_utf8(buf).unwrap_or_else(|_| ".".into())
}

pub fn path_split(name: &str) -> (String, String) {
    match name.rfind('/') {
        Some(i) => (name[..=i].to_string(), name[i + 1..].to_string()),
        None => (String::new(), name.to_string()),
    }
}

pub fn path_join(dir: &str, file: &str) -> String {
    if dir.is_empty() {
        return path_clean(file);
    }
    if file.is_empty() {
        return path_clean(dir);
    }
    if dir.ends_with('/') {
        path_clean(&format!("{dir}{file}"))
    } else {
        path_clean(&format!("{dir}/{file}"))
    }
}

pub fn path_is_abs(p: &str) -> bool {
    p.starts_with('/')
}
