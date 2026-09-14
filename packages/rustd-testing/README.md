# rustd-testing

**This package is optional and unstable (`0.x`). It may be removed.** Prefer
`node:test` / Vitest, `fast-check`, and `memfs`. Use this only if you need a
thin Go `testing.T` shape while porting tests.

Checkpoint 1 implements the `T` harness as **pure JavaScript**. There is no
native addon and no `.node` binary (size = 0). `testing/iotest` bad readers,
`MapFS`/`TestFS`, `quick`, `slogtest`, `synctest`, fuzz, benchmarks, and
`go test` itself are out of scope here.

Issue: [#20](https://github.com/AkaraChen/rustd-js/issues/20).

```js
import { T } from 'rustd-testing';

await T.start('TestAdd', async (t) => {
  t.logf('working in %s', t.tempDir());
  const ok = await t.run('overflow', (t) => {
    t.error('example failure');
  });
  if (!ok) t.log('subtest failed; parent continues');
});
```

**Always `await t.run(...)`.** Forgetting `await` drops the subtest report. The
returned promise has `Symbol.toStringTag === 'T.Run'` and emits
`RUSTD_TESTING_UNAWAITED_RUN` if it is not observed in the same turn.

## When not to use this package

| Need | Use instead |
| --- | --- |
| Run tests | `node:test`, Vitest, Jest |
| Assertions | `node:assert` |
| Mock / fake timers | `node:test` `mock.timers`, `@sinonjs/fake-timers` |
| Property tests | `fast-check` |
| In-memory FS | `memfs` (and later `rustd-fs`) |
| Fuzz | `jazzer.js` / `fast-check` |
| Benchmarks | `tinybench` / `vitest bench` |
| Coverage | `node --experimental-test-coverage`, c8 |

`T.parallel()` is a **no-op marker**. It does not isolate or concurrently
schedule work. Tests that call `setenv`/`chdir` after `parallel()` throw
`TestSetupError`. Concurrent tests sharing `setenv` on the same key is
undefined behavior.

## Differences from Go

- `run` is async (`Promise<boolean>`). Go's `t.Run` blocks.
- `T.start` is the JS root entry; Go injects `*testing.T` from `go test`.
- `parallel()` does not run in parallel.
- `errorf`/`logf` use Node `util.format` (`%s`/`%d`/`%j`/…), not `fmt.Sprintf`
  (`%v`/`%q`/`%T` are not Go).
- `context()` returns `AbortSignal`, aborted when the test finishes. It is not
  `context.Context` (pending `rustd-std`).
- `deadline()` is `[null, false]` unless a future runner injects one.
- `Fatal`/`FailNow` throw `FatalError` (symbol `FATAL`). They never call
  `process.exit`. `run`/`start` check the failed flag so a user `try/catch`
  cannot hide a fatal.
- No `F` / `B` / `Main` / `MainStart` / `Coverage` / `quick` / `slogtest` /
  `synctest`.
- `iotest` readers (`dataErrReader`, `errReader`, `halfReader`, `oneByteReader`,
  `testReader`) wait on the `rustd-io` Reader shape. They are not exported.

## Errors

| Class | `code` | When |
| --- | --- | --- |
| `FatalError` | `ERR_TESTING_FATAL` | `failNow` / `fatal` |
| `SkipError` | `ERR_TESTING_SKIP` | `skip` / `skipf` |
| `TestSetupError` | `ERR_TESTING_SETUP` | `tempDir`/`setenv`/`run` outside a live test, or `setenv`/`chdir` with `parallel` |

## Packaging

Runtime Node `>=20`. Zero runtime dependencies. ESM + CJS. Hand-written
`index.d.ts`. `pnpm build` is a no-op.

```text
pure JS, no native binary: 0 bytes (cap 2,000,000 does not apply)
```
