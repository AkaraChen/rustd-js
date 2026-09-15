import { spawnSync } from 'node:child_process';

export function goExecutable(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

// Preserve the OS error (ENOENT, EACCES, ETIMEDOUT, etc.), including the executable path.
export function checkedSpawnSync(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  return result;
}
