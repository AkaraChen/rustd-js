# rustd-mathx

Go `math/bits` and `math/cmplx` (and later `math/rand`) for Node via Rust + napi-rs.
This is checkpoint 2 of [issue #21](https://github.com/AkaraChen/rustd-js/issues/21): **`math/bits` + `math/cmplx`**. PRNG APIs are not exported yet.

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

## API (`math/cmplx`)

`Complex` is a readonly `[re, im]` tuple. Special-value branches follow Go / C99 Annex G. Bit patterns are compared against Go `math/cmplx` in `test/cmplx.test.mjs`.

| Go | This package |
| --- | --- |
| `Abs` / `Phase` | `cAbs` / `cArg` |
| — | `cNorm` (`re²+im²`; not in Go) |
| `Conj` / `Rect` / `Polar` | `cConj` / `cRect` / `cPolar` → `{ r, φ }` |
| `Exp` / `Log` / `Pow` / `Sqrt` | `cExp` / `cLog` / `cPow` / `cSqrt` |
| `Sin`/`Cos`/`Tan`/`Sinh`/`Cosh`/`Tanh`/`Cot` | `cSin` … `cCot` |
| `Asin`/`Acos`/`Atan`/`Asinh`/`Acosh`/`Atanh` | `cAsin` … `cAtanh` |
| `Inf` / `NaN` / `IsInf` / `IsNaN` | `cInf` / `cNaN` / `cIsInf` / `cIsNaN` |

`cIsInf(x, sign?)` takes an optional `sign` like `math.IsInf`: omitted/`0` matches either infinity, `>0` only `+Inf`, `<0` only `-Inf`. Go's `cmplx.IsInf` is the omitted-sign case.

Required signed-zero cases: `cSqrt([-1, 0]) === [0, 1]`, `cPolar([-1, 0]) === { r: 1, φ: π }`.

## Differences from Go

- No platform-width `bits.Len`, `LeadingZeros`, `Add`, … Use `len32`/`len64` (and the matching width for every other op). A `uint` in Go is 32 or 64 bits depending on the platform; this package never hides that.
- Panic becomes `RangeError`.
- `math` and `math/big` are out of the 28-package split. `math/rand` is the next checkpoint.
- `cLog10` is not exported (issue #21 TS draft has `cLog` only).
- `cNorm` is extra (`re²+im²`). `cIsInf` accepts an optional sign that Go `cmplx.IsInf` does not.
- NaN payloads from explicit `cNaN()` / Go `math.NaN()` use `0x7ff8000000000001`. Libc `sin`/`exp`/… NaN payloads may still differ; those rows go in the known-diff list if tests find them.
- Complex arithmetic uses the platform `libm` via Rust `std`. Finite values that differ from Go's `math` package by ULP are recorded as known diffs rather than approximated.

### Known bit-pattern diffs (`math/cmplx`)

Compared on Linux x64 GNU against Go 1.24.13 `math/cmplx`, cartesian of `{±0,±1,±0.5,±2,π,±Inf,NaN}` plus 64 `NormFloat64` samples (`rand.NewSource(1)`):

| Kind | Handling |
| --- | --- |
| NaN payload `7ff8000000000001` (Go) vs `7ff8000000000000` (V8/JS) | Treated as equal: JS numbers cannot preserve Go's `uvnan` payload |
| Finite libm ULP (typically 1–7, occasionally ~300 on `cPow` of π-heavy inputs) | Same special-value branches as Go; `sin`/`exp`/`pow` come from glibc vs Go `math` |
| `cmplx.Pow(0, NaN+Infi)` | Go panics (`not reached`); we do not throw and follow the `modulus == 0` path |

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
```

See the local `*.node` after `pnpm --filter rustd-mathx build`. Cap is 2 MB; this package should stay well under 500 KB.
