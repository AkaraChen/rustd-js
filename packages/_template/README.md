# Native package template

Private infrastructure probe, not `rustd-template` (the Go template engine).
Copy this directory to `packages/rustd-<name>/`, rename every occurrence of
`rustd-template-smoke`, remove `private`, and implement the issue's API.
Keep the hand-written declarations and loader: the build writes generated
bindings to `.generated.d.ts` only. Native `echoBytes` verifies transport and
packaging; it does not implement any Go package.

Run `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm check:size`, and
`pnpm test:pack` from the root. See `docs/CONVENTIONS.md` for the full contract.

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **327,288 bytes**.
This is the template's size, not a checksum package measurement.

```text
$ ls -l packages/_template/*.node
-rwxrwxr-x 1 akrc akrc 327288 Sep 14 14:11 packages/_template/rustd-template-smoke.linux-x64-gnu.node
```
