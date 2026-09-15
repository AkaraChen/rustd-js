//! Windows counterpart of Go 1.24 mime.initMimeWindows.
use super::{set_extension_type, Tables};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ,
    REG_EXPAND_SZ, REG_SZ,
};

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns a key returned by RegOpenKeyExW.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn content_type(key: &Key) -> Option<String> {
    let name: Vec<u16> = "Content Type\0".encode_utf16().collect();
    let mut bytes = 0;
    let mut kind = 0;
    // SAFETY: name is NUL-terminated; scalar output pointers are valid.
    if unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null(),
            &mut kind,
            null_mut(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
    {
        return None;
    }
    loop {
        let mut value = vec![0u16; (bytes as usize).div_ceil(2)];
        let mut length = bytes;
        // SAFETY: value has capacity for `bytes`; no NUL termination is assumed.
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                null(),
                &mut kind,
                value.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status == ERROR_MORE_DATA {
            bytes = length;
            continue;
        }
        if status != ERROR_SUCCESS || !matches!(kind, REG_SZ | REG_EXPAND_SZ) {
            return None;
        }
        value.truncate(length as usize / 2);
        let end = value.iter().position(|v| *v == 0).unwrap_or(value.len());
        return Some(String::from_utf16_lossy(&value[..end]));
    }
}

pub(super) fn load_defaults(tables: &mut Tables) -> u32 {
    let mut count = 0;
    let mut index = 0;
    loop {
        // Registry key names are at most 255 UTF-16 code units, plus terminator.
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        // SAFETY: HKEY_CLASSES_ROOT is predefined; name/length are writable buffers.
        let status = unsafe {
            RegEnumKeyExW(
                HKEY_CLASSES_ROOT,
                index,
                name.as_mut_ptr(),
                &mut length,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            break;
        }
        index += 1;
        if length < 2 || name[0] != b'.' as u16 {
            continue;
        }
        let extension = String::from_utf16_lossy(&name[..length as usize]);
        let mut handle = null_mut();
        // SAFETY: RegEnumKeyExW returned a NUL-terminated subkey name.
        if unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, name.as_ptr(), 0, KEY_READ, &mut handle) }
            != ERROR_SUCCESS
        {
            continue;
        }
        let key = Key(handle);
        if let Some(value) = content_type(&key) {
            // Match Go's workaround for Windows incorrectly registering .js as text/plain.
            if extension == ".js"
                && matches!(value.as_str(), "text/plain" | "text/plain; charset=utf-8")
            {
                continue;
            }
            if set_extension_type(tables, &extension, &value).is_ok() {
                count += 1;
            }
        }
    }
    count
}
