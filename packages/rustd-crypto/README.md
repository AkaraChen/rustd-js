# rustd-crypto

Synchronous Rust + Node-API streaming hashes and HMACs. This is checkpoint 1 of
[issue #4](https://github.com/AkaraChen/rustd-js/issues/4), not the complete
crypto package. Runtime Node >=20; no JavaScript runtime dependencies and no
`node:crypto` backend. Native classes are private implementation details.

```js
import { createHash, createHmac, hmacEqual } from 'rustd-crypto';

const h = createHash('sha256').update('hello');
const preview = h.sum(); // independent bytes; h remains writable
const fork = h.clone();  // native state snapshot
console.log(h.update(' world').digest('hex'));
console.log(fork.update('!').digest('base64url'));
h.reset(); // reusable even after digest

const mac = createHmac('sha256', new Uint8Array([1, 2, 3]));
mac.update('message');
const tag = mac.digest();
console.log(hmacEqual(tag, tag)); // true
```

## Algorithms

All rows support Hash and HMAC, including incremental input, non-finalizing
`sum`, and reset. Every Hash supports cloning its native chaining state.

| Name | Digest bytes | Block bytes | Default policy |
| --- | ---: | ---: | --- |
| md5 | 16 | 64 | deprecated; explicit opt-in |
| sha1 | 20 | 64 | deprecated; explicit opt-in |
| sha224 | 28 | 64 | enabled |
| sha256 | 32 | 64 | enabled |
| sha384 | 48 | 128 | enabled |
| sha512 | 64 | 128 | enabled |
| sha512-224 | 28 | 128 | enabled |
| sha512-256 | 32 | 128 | enabled |

SHA-512/224 and SHA-512/256 use their specified initial states, not truncated
SHA-512 output. SHA3/SHAKE/cSHAKE/Keccak, KDFs, block ciphers/AEAD, asymmetric
keys/signatures, ML-KEM and the remaining subtle utilities are future
checkpoints. They are absent from the current declarations and registry;
unsupported algorithms throw rather than silently substituting an algorithm.

## API

- `createHash(algo, options?)`: a Hash with readonly `size` and `blockSize`.
  `update(Uint8Array | string)` consumes bytes immediately and returns the same
  object. Strings use UTF-8. `digest()` returns independent `Uint8Array` bytes;
  `digest('hex' | 'base64' | 'base64url')` returns a string. It finalizes the hash.
  Afterward `update`, `digest`, `sum` and `clone` throw `HashFinalizedError`
  until `reset()`. Invalid encoding is rejected before finalization.
- `sum(prefix?)`: copies prefix and appends the current digest. It does not
  alter state, reset or finalize. Prefix defaults to an empty array.
- `clone()`: an independent Hash fork. Copies bounded native state, without
  retaining input or replaying messages. `reset()` restores empty input.
- `squeeze(n)`: reserved on Hash for XOF algorithms; current fixed-output
  algorithms throw `UnsupportedAlgorithmError`.
- `hash(algo, data, options?)`: `createHash(...).update(data).digest()`.
- `createHmac(algo, key, options?)`: key is a `Uint8Array` (Buffer accepted).
  Empty and arbitrarily long keys are supported. Mac has `update`, `digest`,
  `sum`, `reset`, and readonly `size`. Its digest returns bytes and finalizes;
  `reset()` restores the original keyed state. Original key bytes are consumed
  during construction, so later caller mutations do not change the MAC.
- `hmacEqual(a, b)`: native constant-time byte comparison; unequal public
  lengths return false. It does not stop on the first different byte.
- `availableAlgos()`: immutable implemented algorithm list, including legacy
  algorithms that still require opt-in to construct.
- `fips140Enabled(): false`: literal false; no FIPS mode exists.

`options` is `{ allowLegacy?: boolean }`, accepted by `createHash`, `hash` and
`createHmac`. `createHash('md5', { allowLegacy: true })` explicitly enables that
instance. The default is false, including for SHA-1 and HMAC with legacy hashes.
There is no mutable global configuration or warning-based fallback.

`CryptoError` is the base operational error. The exported subclasses and stable
codes are `UnsupportedAlgorithmError` (`ERR_CRYPTO_UNSUPPORTED_ALGORITHM`),
`InsecureAlgorithmError` (`ERR_CRYPTO_INSECURE_ALGORITHM`), and
`HashFinalizedError` (`ERR_CRYPTO_HASH_FINALIZED`). Native failures retain their
original `cause`. Invalid JavaScript argument types/encodings throw TypeError.

## Differences from Go

- `digest()` has Node-style finalization; `sum(prefix)` has Go-style,
  non-finalizing append semantics. Reset can reopen a finalized object.
- Weak algorithms default to rejection; Go callers must explicitly opt in.
- All calls are synchronous. State stays in Rust and each update consumes its
  input immediately. Use a Worker for large computations if event-loop latency
  matters. No async variant or native input accumulation is provided.
- Byte inputs/outputs use Uint8Array, including Buffer views. Byte offsets are
  respected; outputs are independent copies. Strings encode UTF-8.
- No KeyObject or KeyHandle API. Future key operations will use DER/raw bytes.
- `crypto/rand` is outside this package's scope. The future native randomBytes
  convenience function is not implemented in this checkpoint.
- No FIPS-validated backend: `fips140Enabled` is typed as literal `false`.
- Hash/Mac own small native state collected with their JS objects. They need no
  `close()`/`dispose()` and do not expose these methods.

## Security and dependency decisions

RustCrypto sha2/sha1/md-5 0.11 and hmac 0.13 share digest 0.11. We disable default
features and enable zeroize features for native hash state cleanup. Native
chaining state is cleared by the backend's drop implementations; this is not a
guarantee that every compiler temporary is erased. The JS input remains on the
V8 heap and cannot be guaranteed erased. HMAC retains derived keyed state for
reset until collection. This package has no FIPS mode, AWS-LC, OpenSSL, ring,
or C library dependency. The single-platform stripped binary cap is **4 MB**.

`hmacEqual` compares bytes in native code using the subtle crate; input lengths
are public and execution cost depends on their lengths. JS branches, strings,
and caller operations have no constant-time guarantee. No broader side-channel
claim applies to these APIs. Hashes alone do not authenticate data.

## Validation and size

`pnpm --filter rustd-crypto test` verifies published SHA/MD5 and RFC 4231 vectors,
64 committed Go fixtures (regenerated from Go 1.25 on every run), 32 separately
constructed native results verified by Go, rejection of corrupted/empty
verification packets, legacy gates, state transitions, and all eight required
chunk sizes over 1 MiB random input for every Hash and HMAC. `node:crypto` is
used only as an additional independent test oracle and random-data source.
The full one-byte partition test is deliberately slow (about 40 seconds here).

The reference source is `tools/gofixtures/crypto/main.go`. It defaults to
`mise exec -- go` with `GOTOOLCHAIN=go1.25.0`; CI uses `RUSTD_GO=path` to select
Go on PATH. Generate fixtures with:

```sh
GOTOOLCHAIN=go1.25.0 mise exec -- go run ./tools/gofixtures/crypto > packages/rustd-crypto/test/go-fixtures.json
```

Build with `pnpm --filter rustd-crypto build`; check handwritten types with
`pnpm typecheck`, byte budgets with `pnpm check:size`, and clean offline packed
CJS/ESM installations with `pnpm test:pack`. The main tarball contains only the
JS entrypoints, handwritten declarations and README; a platform-specific
optional package contains the binary. No consumer source compilation occurs.

Measured on Linux x64 GNU, Rust 1.97.1 release with symbol stripping:

```text
-rwxrwxr-x 1 akrc akrc 423584 Sep 14 14:31 rustd-crypto.linux-x64-gnu.node
423584 bytes / 4000000 byte cap
```

Only Linux x64 is locally validated in this checkpoint. The shared CI matrix
covers the five requested native targets, but actual five-platform receipts
and Node 20/22 runtime receipts remain necessary before package release.

## Performance

Run `node packages/rustd-crypto/test/benchmark.mjs`. Recorded on 2026-09-14,
AMD EPYC 9645, Linux x64, Node 24.20.0, Go 1.25.0: one sequential pass of
128 MiB per operation in 64 KiB chunks. This shared host has concurrent work;
these numbers describe the observed run and are not a speedup claim.
The machine-readable result is `test/benchmark-results.json`.

| Algorithm | Native Hash MiB/s | Go Hash MiB/s | Native HMAC MiB/s | Go HMAC MiB/s |
| --- | ---: | ---: | ---: | ---: |
| md5 | 382 | 484 | 399 | 560 |
| sha1 | 1268 | 1367 | 1282 | 1387 |
| sha224 | 1170 | 1189 | 1035 | 1252 |
| sha256 | 1186 | 1231 | 1165 | 957 |
| sha384 | 424 | 421 | 381 | 423 |
| sha512 | 404 | 419 | 378 | 398 |
| sha512-224 | 332 | 493 | 360 | 429 |
| sha512-256 | 409 | 420 | 416 | 538 |
