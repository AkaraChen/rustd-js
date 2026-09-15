import { spawnSync } from 'node:child_process';

export function goExecutable(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

export function hostBinaryName(name) {
  const suffix = process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '';
  return `${name}.${process.platform}-${process.arch}${suffix}.node`;
}

// Preserve the OS error (ENOENT, EACCES, ETIMEDOUT, etc.), including the executable path.
export function checkedSpawnSync(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  return result;
}
