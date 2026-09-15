import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Check the native format directly; `file` is not installed on every CI platform.
export function assertStripped(path) {
  const data = readFileSync(path);
  if (process.platform === 'linux') {
    assert.equal(data.subarray(0, 4).toString('hex'), '7f454c46', 'ELF magic');
    assert.equal(data[4], 2, 'ELF64');
    assert.equal(data[5], 1, 'little endian');
    const offset = Number(data.readBigUInt64LE(40));
    const size = data.readUInt16LE(58);
    const count = data.readUInt16LE(60);
    assert.ok(offset > 0 && count > 0, 'ELF section table');
    for (let i = 0; i < count; i++) {
      assert.notEqual(data.readUInt32LE(offset + i * size + 4), 2, 'stripped ELF has no SHT_SYMTAB');
    }
  } else if (process.platform === 'darwin') {
    assert.equal(data.readUInt32LE(0), 0xfeedfacf, 'Mach-O 64 magic');
    const commands = data.readUInt32LE(16);
    let offset = 32;
    for (let i = 0; i < commands; i++) {
      const command = data.readUInt32LE(offset);
      const size = data.readUInt32LE(offset + 4);
      assert.ok(size >= 8, 'Mach-O load command size');
      if (command === 2) { // LC_SYMTAB: exported symbols remain, debug STAB symbols must not.
        const symbols = data.readUInt32LE(offset + 8);
        const count = data.readUInt32LE(offset + 12);
        for (let j = 0; j < count; j++) {
          assert.equal(data[symbols + j * 16 + 4] & 0xe0, 0, 'stripped Mach-O has no STAB symbols');
        }
      }
      offset += size;
    }
  } else if (process.platform === 'win32') {
    assert.equal(data.subarray(0, 2).toString(), 'MZ', 'DOS magic');
    const offset = data.readUInt32LE(60);
    assert.equal(data.readUInt32LE(offset), 0x4550, 'PE signature');
    assert.equal(data.readUInt32LE(offset + 12), 0, 'stripped PE has no COFF symbol table');
    assert.equal(data.readUInt32LE(offset + 16), 0, 'stripped PE has no COFF symbols');
  } else {
    assert.fail(`Unsupported binary format on ${process.platform}`);
  }
}
