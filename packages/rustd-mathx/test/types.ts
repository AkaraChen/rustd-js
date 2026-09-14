import {
  leadingZeros32, leadingZeros64, rotateLeft64, add32, add64, div64, rem32,
} from '../index.js';
const lz: number = leadingZeros32(1);
const lz64: number = leadingZeros64(1n);
const rotated: bigint = rotateLeft64(1n, -1);
const sum32: { sum: number; carryOut: number } = add32(1, 2, 0);
const sum64: { sum: bigint; carryOut: bigint } = add64(1n, 2n, 0n);
const div: { quo: bigint; rem: bigint } = div64(0n, 10n, 3n);
const rem: number = rem32(0, 10, 3);
// @ts-expect-error 64-bit inputs are bigint, not number.
leadingZeros64(1);
// @ts-expect-error 32-bit inputs are number, not bigint.
leadingZeros32(1n);
// @ts-expect-error rotate amount is number.
rotateLeft64(1n, 1n);
// @ts-expect-error carry is required.
add32(1, 2);
void [lz, lz64, rotated, sum32, sum64, div, rem];
