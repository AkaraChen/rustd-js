# rustd-mathx

Go `math/bits`, `math/cmplx`, and `math/rand` for Node via Rust + napi-rs.
This is checkpoint 5 of [issue #21](https://github.com/AkaraChen/rustd-js/issues/21): **`math/bits` + `math/cmplx` + PCG/ChaCha8 + v1 `newSource` + N-family + `perm`/`shuffle` + Zipf + `normFloat64`/`expFloat64` + auto-seeded `defaultRand`**, recertified after Zipf/ziggurat tables (`npm pack` CJS/ESM smoke + linux-x64 size). `seedDefault` is **not** exported (decision: Go `math/rand/v2` has no `Seed`).

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
- `math` and `math/big` are out of the 28-package split.
- `math/rand` checkpoint 4 adds Zipf, `normFloat64`/`expFloat64` (Go ziggurat; v1 vs v2 consume `Uint32` vs `Uint64`), and `defaultRand()` (one auto-seeded ChaCha8 via `crypto.getRandomValues`). **`seedDefault(seed: bigint)` is not exported.** Issue #21 shape 8 asked to confirm a deprecated global reseed; Go `math/rand/v2` has no `Seed`, and Go v1 `rand.Seed` reseeds a lagged-Fibonacci global — a different generator than this ChaCha8 `defaultRand()`. Reseeding ChaCha8, or swapping `defaultRand()` to `newSource(seed)`, would invent a non-Go API. Deterministic streams use `newPCG` / `newChaCha8` / `newSource`. Go's `NewZipf` returns nil on `s <= 1` or `v < 1`; we throw `RangeError` instead of returning null.
- v2 PCG/ChaCha8 throw `RangeError` on v1-only methods (`int63`, `int63n`, `intn`, `read`, …). v2 has no `Read`.
- `int()` / `uint()` are `bigint` (64-bit Go `int`/`uint`; issue #21 shape 1). `intN(n: number)` stays `number` because `n` is a JS safe integer.
- `Shuffle` is copy + in-place typed-array APIs rather than Go's `swap` callback (issue #21 recommended shape). `perm`/`shuffle` live in `index.js` so the Fisher-Yates / v1 `Intn` loops are visible; index draws come from native `uint64n` / v1 `int31n`-fast so consumption matches Go.
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

## API (`math/rand` checkpoints 1–4)

**This is a PRNG, not a CSPRNG.** Do not use it for tokens, keys, nonces, or session IDs. Use `crypto.getRandomValues` or `rustd-crypto.randomBytes` for anything security-sensitive.

```js
import { newPCG, newChaCha8, newSource, randFromState, Zipf, defaultRand } from 'rustd-mathx';

const r = newPCG(1n, 2n);
r.uint64(); // 14192431797130687760n  (same as Go rand/v2.NewPCG(1,2))
const bytes = r.state();           // 20 bytes, Go MarshalBinary
const r2 = randFromState(bytes);   // continues the same stream

const c = newChaCha8(Uint8Array.of(1, ...new Uint8Array(31)));
c.state(); // 48 bytes (`chacha8:` + used + seed)

r.uint64N(7n);
r.intN(100);
r.float64();
r.perm(4);                 // Uint32Array, Go Perm
r.shuffle([0, 1, 2, 3]);   // copy; Fisher-Yates via uint64N
const buf = Uint32Array.of(0, 1, 2, 3);
r.shuffleInPlace(buf);

const v1 = newSource(1n);
v1.int63();   // 5577006791947779410n
v1.intn(50);
v1.read(8);   // 52fdfc072182654f after a fresh NewSource(1)

r.normFloat64();
r.expFloat64();
new Zipf(r, 1.1, 1, 100).uint64();
defaultRand(); // auto-seeded ChaCha8; same instance on later calls
```

`defaultRand()` is a PRNG seeded from `crypto.getRandomValues`. It is **not** a CSPRNG and must not be used for tokens, keys, nonces, or session IDs.

`state()` / `randFromState()` bytes match Go `encoding.BinaryMarshaler` / `BinaryUnmarshaler` exactly, including the ChaCha8 `"readbuf:"` prefix when a Go `Read` left unconsumed bytes.

## Not a CSPRNG

`newPCG` / `newChaCha8` / `newSource` / `randFromState` / `defaultRand` are **predictable PRNGs** (`defaultRand` is auto-seeded but still not a CSPRNG). Do not use them for tokens, keys, nonces, or session IDs. Use `crypto.getRandomValues` or `rustd-crypto` for anything security-sensitive.

## Performance

Single calls to `leadingZeros32` are typically **slower** than `Math.clz32` because of the native round-trip. Use the JS builtin for one-off 32-bit clz. The native path is for Go-parity 8/16/64-bit ops, rotate/reverse, and full-width add/mul/div.

Local Linux x64 GNU, Node v24.20.0, 200_000 iterations:

| op | this package | JS |
| --- | ---: | ---: |
| `leadingZeros32` | 36.2 ms | `Math.clz32` 2.9 ms (**faster**; prefer the builtin for 32-bit clz) |
| `onesCount32` | 25.0 ms | bit-loop 6.3 ms (JS wins at this batch size because of FFI) |

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (after Zipf/ziggurat tables): **482,400 bytes** (issue cap 2 MB; expected ≪ 500 KB).

```text
$ ls -l packages/rustd-mathx/*.node
-rwxrwxr-x 1 akrc akrc 482400 Sep 14 17:59 packages/rustd-mathx/rustd-mathx.linux-x64-gnu.node
```
