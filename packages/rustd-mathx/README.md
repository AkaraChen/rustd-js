# rustd-mathx

Go `math/bits` (and later `math/cmplx` / `math/rand`) for Node via Rust + napi-rs.
This is checkpoint 1 of [issue #21](https://github.com/AkaraChen/rustd-js/issues/21): **`math/bits` only**. Complex and PRNG APIs are not exported yet.

Runtime Node >=20. No JavaScript runtime dependencies.

```js
import { leadingZeros64, rotateLeft64, div64, add64 } from 'rustd-mathx';

leadingZeros64(1n);            // 63
rotateLeft64(1n, -1);          // 2n ** 63n  (same as Go bits.RotateLeft64)
add64(0xffffffffffffffffn, 1n, 0n); // { sum: 0n, carryOut: 1n }
div64(0n, 10n, 3n);            // { quo: 3n, rem: 1n }
```

## API (`math/bits`)

8/16/32-bit arguments are unsigned `number` in `[0, 2^w-1]`. 64-bit arguments are `bigint` in `[0n, 2n**64n-1n]`. Out-of-range values throw `RangeError` rather than wrapping.

| Go | This package |
| --- | --- |
| `LeadingZeros8/16/32/64` | `leadingZeros8/16/32/64` |
| `TrailingZeros*` | `trailingZeros*` |
| `OnesCount*` | `onesCount*` |
| `Len*` | `len*` |
| `RotateLeft*` | `rotateLeft*` (`k` may be negative = rotate right) |
| `Reverse*` | `reverse*` |
| `ReverseBytes16/32/64` | `reverseBytes16/32/64` |
| `Add32/64` | `add32/64` → `{ sum, carryOut }` (carry is 0 or 1) |
| `Sub32/64` | `sub32/64` → `{ diff, borrowOut }` |
| `Mul32/64` | `mul32/64` → `{ hi, lo }` |
| `Div32/64` | `div32/64` → `{ quo, rem }` |
| `Rem32/64` | `rem32/64` |

`Div*` / `Rem*` throw `RangeError` with Go's panic text: `integer divide by zero` or `integer overflow` (`hi >= y`).

## Differences from Go

- No platform-width `bits.Len`, `LeadingZeros`, `Add`, … Use `len32`/`len64` (and the matching width for every other op). A `uint` in Go is 32 or 64 bits depending on the platform; this package never hides that.
- Panic becomes `RangeError`.
- `math`, `math/big`, `math/cmplx`, and `math/rand` are not in this checkpoint. `math`/`math/big` are out of the 28-package split entirely.

## Not a CSPRNG

When `math/rand` lands in a later checkpoint it will be a **PRNG**, not suitable for tokens, keys, nonces, or session IDs. Use `crypto.getRandomValues` or `rustd-crypto` for anything security-sensitive. That warning is repeated here so callers do not treat this package name as cryptographic.

## Performance

Single calls to `leadingZeros32` are typically **slower** than `Math.clz32` because of the native round-trip. Use the JS builtin for one-off 32-bit clz. The native path is for Go-parity 8/16/64-bit ops, rotate/reverse, and full-width add/mul/div.

Local Linux x64 GNU, Node v24.20.0, 200_000 iterations:

| op | this package | JS |
| --- | ---: | ---: |
| `leadingZeros32` | 36.2 ms | `Math.clz32` 2.9 ms (**faster**; prefer the builtin for 32-bit clz) |
| `onesCount32` | 25.0 ms | bit-loop 6.3 ms (JS wins at this batch size because of FFI) |

## Size

Release + strip, local Linux x64 GNU:

```text
$ ls -l packages/rustd-mathx/*.node
-rwxrwxr-x 1 akrc akrc 368096 Sep 14 16:33 packages/rustd-mathx/rustd-mathx.linux-x64-gnu.node
```

368,096 bytes (well under the 2 MB cap and the 500 KB "something is wrong" check).
