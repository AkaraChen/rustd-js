import { echoBytes } from '../index.js';
const output: Uint8Array = echoBytes(new Uint8Array([1]));
// @ts-expect-error Strings require explicit encoding.
echoBytes('data');
// @ts-expect-error Byte output is not a number.
const wrong: number = output;
