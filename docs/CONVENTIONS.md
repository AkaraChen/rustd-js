# Package conventions

## Ownership and layout

Each public package is `rustd-<name>` at `packages/rustd-<name>/`, versioned
independently starting at 0.1.0. Use the matching GitHub issue as the acceptance
specification. `packages/_template/` is a private transport probe, not a public
package or the `rustd-template` template engine. The checksum implementation
belongs to its assigned peer; shared infrastructure must not duplicate it.

Each package contains `Cargo.toml`, `Cargo.lock`, `build.rs`, `src/lib.rs`,
`index.js` (CJS), `index.mjs` (ESM), hand-written `index.d.ts`, `test/`, and
`README.md`. Crates are independent to avoid shared Cargo manifest contention.
Root pnpm scripts discover packages; missing required scripts fail the build.
No package is silently skipped. Build tools require Node 24; published package
runtimes support Node >=20 and use N-API 8. Go fixtures use Go 1.24.13 per the
current toolchain contract; features introduced later need an explicit decision.

## Type and error contracts

Use `Uint8Array` for bytes, including Buffer inputs. Respect byte offsets and
lengths of slices. Specify whether returned buffers are copied or borrowed;
default to an independent copy. Never retain an unrooted JS buffer across async
work. Integers through uint32 use validated `number`; uint64 uses `bigint`.
Reject out-of-range values before N-API conversion; never silently truncate.
128-bit digests expose big-endian bytes and a documented bigint accessor.

Each public operational error is a package-specific `Error` subclass with a
stable `code: string` and optional `operation`, `path`, and `cause` fields.
Normalize native failures at the JS boundary without losing the cause. Document
which codes callers can rely on. Never turn a failure into a sentinel success,
throw strings, or use a Rust panic for invalid input. The transport template has
no operational error surface; add the package's errors when adding operations.

Keep short, bounded pure computation synchronous. Use async work for blocking
I/O and expensive computation; specify cancellation and cleanup semantics.
Do not add a thread pool to every package. State ownership, reset, clone,
resource cleanup, and post-close behavior must be explicit in each interface.

Write declarations by hand with no public `any`, including callback arguments.
Build output must never overwrite `index.d.ts`. Test positive assignments and
negative `@ts-expect-error` cases under strict TypeScript, without skipLibCheck.
ESM and CJS expose the same named exports and share native state.

## Go interoperability

Run `pnpm test:go` for the template probe. The tool actually invokes Go (locally
`mise exec -- go`, CI `RUSTD_GO=path`), then the native implementation. It does
not substitute cached constants. `pnpm test` also runs these bidirectional tests.

For a package, implement an adapter exporting
`evaluate(data: Uint8Array, incremental: boolean): Record<string, string>` and
invoke `node scripts/compare-with-go.ts checksum path/to/adapter.mjs` (or the
package name registered in the Go tool). Register additional codecs in the Go
generator. Package `test/go-compat.test.mjs` must independently exercise:

1. Go-generated inputs and expected outputs → native parser/computation.
2. JS-generated inputs → native serialized results → Go verification.

The checksum generator covers 13 deterministic algorithms, lengths
0/1/55/56/64/65/1024/1048576, and incremental chunks 1/3/7/64/1024/remainder.
JSON digest fields are fixed-width big-endian lowercase hex; adapters convert
number/bigint results without precision loss. Custom CRC32 uses Go's reversed
polynomial 0xa833982b. `maphash` requires separate statistical acceptance, not
Go digest equality. This generator is infrastructure, not evidence that the
checksum native implementation has passed.

Generate fixtures with `mise exec -- go run ./tools/gofixtures -pkg checksum
-out checksum.json`. Mismatches print the failing field and reproducing input;
packet verification rejects empty cases, missing/extra fields, malformed bytes,
and wrong values. The harness tests intentionally corrupt output to prove
failure detection. Add package-specific malformed input and interoperability
fixtures beyond this common boundary corpus.

## Build and packaging

Release profile: `opt-level="z"`, `lto="fat"`, `codegen-units=1`,
`strip="symbols"`, `panic="abort"`. Keep runtime JS dependencies empty.
Five optional native packages: darwin-arm64, darwin-x64, linux-x64-gnu,
linux-arm64-gnu, win32-x64-msvc. Main package contains JS/declarations/docs;
native packages contain one platform binary and matching `os`/`cpu` metadata.
No source compilation during consumer installation. Unsupported platforms fail
explicitly; a broken local binary must preserve its original loading error.

Use `napi build --platform --release --no-js --dts .generated.d.ts` to preserve
hand-written wrappers. For releases, use `napi create-npm-dirs`, gather the
five CI artifacts with `napi artifacts`, and stage `napi prepublish -t npm`
according to the pinned CLI help. Publishing is a separate authorized action.
`pnpm test:pack` locally packs the main and native package, installs both in a
clean directory offline, checks the main tarball excludes `.node`, and verifies
CJS + ESM resolution and native calls. CI repeats on five native platforms and
also loads the packed runtime on Node 20. A workflow file is not a passing CI
receipt; retain actual per-platform run evidence before release.

Size caps use decimal bytes after strip: default 2,000,000; checksum 1,500,000
(issue #6's stricter cap); crypto 4,000,000; tls 6,000,000; http 5,000,000;
image 3,000,000. `pnpm check:size` fails on missing or oversized binaries.
Record real `ls -l` output and actual byte count in each package README.

## New package checklist

1. Claim the assigned task and independent worktree; copy/rename the template.
2. Read the issue and resolve interface ambiguities before native implementation.
3. Add native operations, error wrappers, declarations, and strict type examples.
4. Implement Go → JS and JS → Go tests plus malformed input and state tests.
5. Pass build, typecheck, test, test:go, check:size, and clean package install.
6. Record real size, benchmarks when required, and all differences from Go.
7. Collect five-platform CI evidence before release; write validated evidence to
   the task state. Never count a transport probe as package acceptance.
