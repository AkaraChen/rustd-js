# rustd-js integration ledger

Integrator worktree: `~/Developer/rustd-js-grok-integrator`  
Local stand-in for `main`: `grok-integrator-main` (the `main` branch is locked by `~/Developer/rustd-js`; pushes go to `origin/main`).

## Package table

| 包名 | 已合 / 对应分支 | 状态 |
|---|---|---|
| rustd-checksum | `pkg/rustd-checksum-grok-bulk-3` | merged |
| rustd-containers | `pkg/rustd-containers-grok-bulk-2` | merged; follow-up `b672b3f` pending (`7ed487b` **is** an ancestor) |
| rustd-compress | `pkg/rustd-compress-grok-bulk-9` @ `4af21a6` | merged; follow-up `b692e78` pending (`4af21a6` **is** an ancestor; lzwDecompressStream) |
| rustd-compress | `pkg/rustd-compress-grok-bulk-worker` | superseded by `pkg/rustd-compress-grok-bulk-9` (ancestor of the merge) |
| rustd-archive | `pkg/rustd-archive-grok-bulk-6` @ `ee92b1d` | merged (`1295731`); pax mtime + UnixMilli fixtures (`a23cfc0` **is** an ancestor) |
| rustd-archive | `pkg/rustd-archive-grok-bulk-3` | superseded by `pkg/rustd-archive-grok-bulk-6` |
| rustd-archive | `pkg/rustd-archive-grok-bulk-6` @ `f2d0491` | superseded — rewritten parallel history; replaced by later descendant tips |
| rustd-serial | `pkg/rustd-serial-grok-bulk-7` @ `0a51358` | merged (`ccb0a37`); XML Decode schema (`39a26ca` **is** an ancestor) |
| rustd-serial | `pkg/rustd-serial-grok-bulk-worker` | superseded by `pkg/rustd-serial-grok-bulk-7` (ancestor of the merge) |
| rustd-serial | `pkg/rustd-serial-grok-bulk-7` @ `1a50b16` | superseded — rewritten parallel history; replaced by descendant `0a51358` |
| rustd-image | `pkg/rustd-image-grok-bulk-8` @ `ac8f590` | merged; follow-up `ee6301c` pending (`ac8f590` **is** an ancestor) |
| rustd-image | `pkg/rustd-image-grok-bulk-2` | superseded by `pkg/rustd-image-grok-bulk-8` |
| rustd-log | `pkg/rustd-log-grok-bulk-4` | merged |
| rustd-unicode | `pkg/rustd-unicode-grok-bulk-worker` @ `f210fc7` | merged (`b03be1c`) |
| rustd-gotool | `pkg/rustd-gotool-grok-bulk-4` @ `38c8e45` | merged (`837c659`); follow-up `bb6a034` pending |
| rustd-encoding | `pkg/rustd-encoding-grok-bulk-2` @ `b5f930e` | rejected — `pnpm-lock.yaml` conflict vs `rustd-log`; tests were green; still un-rebased |
| rustd-mathx | `pkg/rustd-mathx-grok-bulk-10` @ `efd0592` | rejected this round — `pnpm-lock.yaml` conflict; tests green (32). Newer tip `a8246ba` still conflicts (merge-base `de3e643`) |
| rustd-mime | `pkg/rustd-mime-grok-bulk-3` @ `0660cea` | rejected — `pnpm-lock.yaml` conflict; merge-base still `0da14ff` (pre-log) |
| rustd-regexsyntax | `pkg/rustd-regexsyntax-grok-bulk-7` @ `872f779` | pending — merge-tree CLEAN (after the owner-12 first-time packages) |
| rustd-mail | `pkg/rustd-mail-grok-bulk-worker` @ `2852022` | pending — worker in progress; merge-tree CLEAN vs current main |
| rustd-testing | `pkg/rustd-testing-grok-bulk-6` | rejected-by-owner (issue #20, 2026-09-14) |
| rustd-std | `pkg/rustd-std-*` | rejected-by-owner (issue #29, 2026-09-14); no current unmerged branch |
| rustd-debugfmt | `pkg/rustd-debugfmt-grok-bulk-5` | rejected-by-owner (issue #18; owner cut 2026-09-15: largest binary, niche) |

## Round 2026-09-14T17:33:03+02:00

Agent: `grok-integrator`  
`origin/main` before: `2040f3c`  
`origin/main` after: `a25736c` (this file lands as a follow-up commit)

### Merged (verified green, `--no-ff`, pushed)

| 分支 | 包 | 验证 | merge sha |
|---|---|---|---|
| `pkg/rustd-checksum-grok-bulk-3` | rustd-checksum | build + 10 tests pass | `bcf2365` |
| `pkg/rustd-containers-grok-bulk-2` | rustd-containers | build + 10 tests pass (6 unused_assignments warnings in `sais.rs`, not a failure) | `7ed487b` |
| `pkg/rustd-compress-grok-bulk-9` | rustd-compress | build + 16 tests pass at `c2e1757`; merge tip was `59e3167` (extra LZW tests pushed during verify; vendor `unexpected_cfgs` warnings, not a failure) | `a25736c` |

### Rejected

None this round.

### Superseded

- `pkg/rustd-compress-grok-bulk-worker` (`d92ccc8`, 2026-09-14 15:45) → replaced by `pkg/rustd-compress-grok-bulk-9`. Not merged on its own. It is an ancestor of the compress-9 merge.

### Not processed this round (oldest first; max 3 packages/round)

Duplicates listed with both tips; next round should verify only the newest of each pair.

1. `pkg/rustd-archive-grok-bulk-3` (`da2a6be`) — skip; duplicate of #11
2. `pkg/rustd-serial-grok-bulk-worker` (`b6aeb7f`) — skip; duplicate of #10
3. `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — skip; duplicate of newest image
4. `pkg/rustd-log-grok-bulk-4` (`1b0b9bb`)
5. `pkg/rustd-testing-grok-bulk-6` (`9fc9508`)
6. `pkg/rustd-gotool-grok-bulk-4` (`4591592`)
7. `pkg/rustd-unicode-grok-bulk-worker` (`b0e66f8`)
8. `pkg/rustd-encoding-grok-bulk-2` (`e4e1a7a`)
9. `pkg/rustd-mathx-grok-bulk-10` (`f06c80d`)
10. `pkg/rustd-serial-grok-bulk-7` (`def2c86`) — newest serial
11. `pkg/rustd-archive-grok-bulk-6` (`a23cfc0`) — newest archive
12. `pkg/rustd-mime-grok-bulk-3` (`e5eed31`)
13. `pkg/rustd-debugfmt-grok-bulk-5` (`27aece0`)
14. `pkg/rustd-image-grok-bulk-8` (`5621cf0`) — newest image

Suggested next three: newest archive (`bulk-6`), newest serial (`bulk-7`), `rustd-log` (`bulk-4`).

### Notes

- First worktree install: `pnpm install --prefer-offline --no-frozen-lockfile`. Sandbox has `CI=true` (pnpm frozen-lockfile); subsequent `--filter` builds used `CI=false`. Pre-existing lockfile drift: `packages/_template` optional platform packages vs `pnpm-lock.yaml`. Lockfile was **not** committed.
- Builds: `CARGO_BUILD_JOBS=2 nice -n 10 pnpm --filter rustd-<x> {build,test}`.
- Go via `mise exec -- go` (go1.24.13). Rust 1.97.1. Node v24.20.0.

## Round 2026-09-14T17:51:42+02:00

Agent: `grok-integrator`  
`origin/main` before: `345ff6c`  
`origin/main` after: `0da14ff` (this file lands as a follow-up commit)

### Merged (verified green, `--no-ff`, pushed)

| 分支 | 包 | 验证 | merge sha |
|---|---|---|---|
| `pkg/rustd-archive-grok-bulk-6` @ `a23cfc0` | rustd-archive | build + 18 tests pass | `de3e643` |
| `pkg/rustd-serial-grok-bulk-7` @ `39a26ca` | rustd-serial | build + 30 tests pass | `34c7cbc` |
| `pkg/rustd-image-grok-bulk-8` @ `ac8f590` | rustd-image | build + 28 tests pass (3 `dead_code` warnings in `draw.rs`/`image.rs`, not a failure); includes #19 §4.8 bomb PNG/GIF tests | `0da14ff` |

### Rejected

None this round.

### Superseded

- `pkg/rustd-archive-grok-bulk-3` (`da2a6be`, 2026-09-14 16:05) → replaced by `pkg/rustd-archive-grok-bulk-6`. Not merged. Not an ancestor of `a23cfc0`.
- `pkg/rustd-serial-grok-bulk-worker` (`b6aeb7f`, 2026-09-14 16:06) → replaced by `pkg/rustd-serial-grok-bulk-7`. Ancestor of the merge.
- `pkg/rustd-image-grok-bulk-2` (`d9c447c`, 2026-09-14 16:09) → replaced by `pkg/rustd-image-grok-bulk-8`. Not an ancestor of `ac8f590`.

### Not processed this round (oldest first; max 3 packages/round)

1. `pkg/rustd-log-grok-bulk-4` (`1b0b9bb`)
2. `pkg/rustd-testing-grok-bulk-6` (`9fc9508`)
3. `pkg/rustd-gotool-grok-bulk-4` (`4591592`)
4. `pkg/rustd-encoding-grok-bulk-2` (`6654979`)
5. `pkg/rustd-unicode-grok-bulk-worker` (`0fa656b`)
6. `pkg/rustd-mime-grok-bulk-3` (`97079ec`)
7. `pkg/rustd-mathx-grok-bulk-10` (`583c6b7`)
8. `pkg/rustd-debugfmt-grok-bulk-5` (`c0747e6`)
9. `pkg/rustd-compress-grok-bulk-9` extra `4af21a6` — follow-up tests on already-merged compress (old tip `59e3167` **is** an ancestor; safe to verify+merge next)
10. `pkg/rustd-archive-grok-bulk-6` rewrite `f2d0491` — **do not merge**; parallel rewrite vs merged `a23cfc0`

Suggested next three: `rustd-log` (`bulk-4`), `rustd-testing` (`bulk-6`), `rustd-gotool` (`bulk-4`).

### Notes

- Duplicate policy: verified only the newest of archive/serial/image; older siblings marked superseded.
- After merging archive @ `a23cfc0`, worker rewrote `pkg/rustd-archive-grok-bulk-6` to `f2d0491` (not a descendant). Next round must not merge that rewrite.
- `CI=false` on `--filter` builds. Lockfile drift discarded, not committed.
- Builds: `CARGO_BUILD_JOBS=2 nice -n 10 pnpm --filter rustd-<x> {build,test}`.
- Go via `mise` (go1.24.13). Rust 1.97.1. Node v24.20.0.

## Round 2026-09-14T18:08:48+02:00

Agent: `grok-integrator`  
`origin/main` before: `0d5273d`  
`origin/main` after: `7055d9c` (this file lands as a follow-up commit)

### Merged (verified green, `--no-ff`, pushed)

| 分支 | 包 | 验证 | merge sha |
|---|---|---|---|
| `pkg/rustd-log-grok-bulk-4` @ `1b0b9bb` | rustd-log | build + 9 tests pass | `d7ac780` |
| `pkg/rustd-compress-grok-bulk-9` @ `4af21a6` | rustd-compress follow-up | build + 18 tests pass (was 16; vendor `unexpected_cfgs` warnings, not a failure) | `7055d9c` |

### Rejected

- `pkg/rustd-mime-grok-bulk-3` @ `40d4345` — **build+test green** (25 tests) but `git merge --no-ff` conflicted. `git merge --abort`. Not merged.
  First 40 lines of conflict:

```
Auto-merging pnpm-lock.yaml
CONFLICT (content): Merge conflict in pnpm-lock.yaml
Automatic merge failed; fix conflicts and then commit the result.
--- conflicted files ---
pnpm-lock.yaml
diff --cc pnpm-lock.yaml
index f887b1c,f706121..0000000
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@@ -22,7 -22,7 +22,11 @@@ importers
  
    packages/rustd-crypto: {}
  
++<<<<<<< HEAD
 +  packages/rustd-log: {}
++=======
+   packages/rustd-mime: {}
++>>>>>>> origin/pkg/rustd-mime-grok-bulk-3
  
  packages:
```

  Cause: mime branch merge-base is `0da14ff` (pre-log). After `rustd-log` landed, both sides add a different `importers` entry. Worker should rebase onto `origin/main` and re-push. LoopX `todo update --note` on `todo_fcf7f621ffd8` was refused (`agent_id=grok-integrator` cannot update a todo `claimed_by=grok-bulk-3`).

- `pkg/rustd-testing-grok-bulk-6` — `rejected-by-owner` (issue #20). Skipped, branch not modified.
- `pkg/rustd-std-*` — `rejected-by-owner` (issue #29). No current unmerged branch.

### Superseded / do-not-merge

- `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — still superseded by `pkg/rustd-image-grok-bulk-8`.
- `pkg/rustd-archive-grok-bulk-6` rewrite `f2d0491` — superseded by later tip `8f86f68` (`a23cfc0` **is** an ancestor of `8f86f68`).
- `pkg/rustd-serial-grok-bulk-7` @ `1a50b16` — **do not merge**; rewritten parallel history vs merged `39a26ca` (merge-base with old tip is `2040f3c`). Extra XML Decode work lives on the rewrite; worker should rebase onto current `origin/main`.

### Not processed this round (oldest first; max 3 packages/round)

1. `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — skip; superseded
2. `pkg/rustd-testing-grok-bulk-6` (`9fc9508`) — skip; rejected-by-owner
3. `pkg/rustd-image-grok-bulk-8` extra `cfcb031` — follow-up (`0da14ff` **is** an ancestor; npm pack smoke)
4. `pkg/rustd-serial-grok-bulk-7` rewrite `1a50b16` — **do not merge**
5. `pkg/rustd-mathx-grok-bulk-10` (`d41f459`)
6. `pkg/rustd-gotool-grok-bulk-4` (`c5a93fc`)
7. `pkg/rustd-mime-grok-bulk-3` (`40d4345`) — waiting on rebase after lockfile conflict
8. `pkg/rustd-debugfmt-grok-bulk-5` (`12e8617`)
9. `pkg/rustd-archive-grok-bulk-6` follow-up `8f86f68` — safe (`a23cfc0` is ancestor)
10. `pkg/rustd-unicode-grok-bulk-worker` (`f210fc7`)
11. `pkg/rustd-encoding-grok-bulk-2` (`b5f930e`)

Suggested next three: image follow-up (`cfcb031`), `rustd-mathx` (`bulk-10`), `rustd-gotool` (`bulk-4`).

### Notes

- Owner skip list now in force: `pkg/rustd-testing-*` (#20), `pkg/rustd-std-*` (#29).
- `main` is locked in `~/Developer/rustd-js`; this worktree merges on `grok-integrator-main` and `git push origin grok-integrator-main:main`.
- `CI=false` on `--filter` builds. Lockfile drift discarded, not committed.
- Builds: `CARGO_BUILD_JOBS=2 nice -n 10 pnpm --filter rustd-<x> {build,test}`.
- Go via `mise` (go1.24.13). Rust 1.97.1. Node v24.20.0.

## Round 2026-09-14T18:31:51+02:00

Agent: `grok-integrator`  
`origin/main` before: `befb9d6`  
`origin/main` after: `837c659` (this file lands as a follow-up commit)

Priority this round: first-time remaining packages from the owner 12 (`unicode`, `encoding`, `gotool`). Follow-ups of already-merged packages deferred.

### Merged (verified green, `--no-ff`, pushed)

| 分支 | 包 | 验证 | merge sha |
|---|---|---|---|
| `pkg/rustd-unicode-grok-bulk-worker` @ `f210fc7` | rustd-unicode | build + 24 tests pass | `b03be1c` |
| `pkg/rustd-gotool-grok-bulk-4` @ `38c8e45` | rustd-gotool | build + 14 tests pass (6 `unused_assignments`/`dead_code` warnings in parser/scanner/ast/print/token, not a failure) | `837c659` |

### Rejected

- `pkg/rustd-encoding-grok-bulk-2` @ `b5f930e` — **build+test green** (17 tests) but `git merge --no-ff` conflicted. `git merge --abort`. Not merged.
  First 40 lines of conflict:

```
Auto-merging pnpm-lock.yaml
CONFLICT (content): Merge conflict in pnpm-lock.yaml
Automatic merge failed; fix conflicts and then commit the result.
--- conflicted files ---
pnpm-lock.yaml
--- importers on origin/main ---
  packages/_template: {}
  packages/rustd-crypto: {}
  packages/rustd-log: {}
--- importers on encoding branch ---
  packages/_template: {}
  packages/rustd-crypto: {}
  packages/rustd-encoding: {}
```

  Cause: encoding merge-base is `0d5273d` (pre-log). After `rustd-log` landed, both sides add a different `importers` entry. Worker should rebase onto current `origin/main` and re-push. LoopX `todo update --note` on `todo_2f742a305406` was refused (`agent_id=grok-integrator` cannot update a todo `claimed_by=grok-bulk-worker`).

- `pkg/rustd-testing-grok-bulk-6` — `rejected-by-owner` (issue #20). Skipped, branch not modified.
- `pkg/rustd-debugfmt-grok-bulk-5` — `rejected-by-owner` (issue #18; owner cut: largest binary, niche). Skipped, branch not modified.

### Superseded / do-not-merge

- `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — still superseded by `pkg/rustd-image-grok-bulk-8`.
- `pkg/rustd-serial-grok-bulk-7` @ `1a50b16` — superseded; later tip `0a51358` **is** a descendant of merged `39a26ca`.
- `pkg/rustd-compress-grok-bulk-9` @ `27cc87d` — earlier non-descendant rewrite; later tip `760570d` **is** a descendant of merged `4af21a6`.

### Not processed this round (oldest first; max 3 packages/round)

1. `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — skip; superseded
2. `pkg/rustd-testing-grok-bulk-6` (`9fc9508`) — skip; rejected-by-owner
3. `pkg/rustd-serial-grok-bulk-7` follow-up `0a51358` — safe (`39a26ca` is ancestor); deferred (first-time packages first)
4. `pkg/rustd-encoding-grok-bulk-2` (`b5f930e`) — waiting on rebase after lockfile conflict
5. `pkg/rustd-mathx-grok-bulk-10` (`c6b8e8e`) — first-time remaining
6. `pkg/rustd-containers-grok-bulk-2` follow-up `d0fe087` — safe (`7ed487b` is ancestor)
7. `pkg/rustd-image-grok-bulk-8` follow-up `a4fa7cb` — safe (`ac8f590` is ancestor)
8. `pkg/rustd-debugfmt-grok-bulk-5` (`f17e348`) — skip; rejected-by-owner
9. `pkg/rustd-archive-grok-bulk-6` follow-up `cb16c2a` — safe (`a23cfc0` is ancestor)
10. `pkg/rustd-compress-grok-bulk-9` follow-up `760570d` — safe (`4af21a6` is ancestor)
11. `pkg/rustd-mime-grok-bulk-3` (`ca892a9`) — waiting on rebase (merge-base still `0da14ff`)

Suggested next three: `rustd-mathx` (`bulk-10`), encoding after rebase, mime after rebase. If encoding/mime still un-rebased, take mathx + oldest safe follow-ups (serial `0a51358`, containers `d0fe087`).

### Notes

- Owner skip list now in force: `pkg/rustd-testing-*` (#20), `pkg/rustd-std-*` (#29), `pkg/rustd-debugfmt-*` (#18).
- First-time remaining of the owner 12: `encoding` (rebase), `mime` (rebase), `mathx`. `mail` still in progress on grok-bulk-worker.
- `main` is locked in `~/Developer/rustd-js`; this worktree merges on `grok-integrator-main` and `git push origin grok-integrator-main:main`.
- `CI=false` on `--filter` builds. Lockfile drift discarded, not committed.
- Builds: `CARGO_BUILD_JOBS=2 nice -n 10 pnpm --filter rustd-<x> {build,test}`.
- Go via `mise` (go1.24.13). Rust 1.97.1. Node v24.20.0.

## Round 2026-09-14T18:53:27+02:00

Agent: `grok-integrator`  
`origin/main` before: `bfdd10f`  
`origin/main` after: `1295731` (this file lands as a follow-up commit)

Priority this round: first-time remaining of the owner 12 (`mathx`) plus oldest mergeable follow-ups (`serial`, `archive`). encoding/mime still un-rebased at previous SHAs — not re-verified.

### Merged (verified green, `--no-ff`, pushed)

| 分支 | 包 | 验证 | merge sha |
|---|---|---|---|
| `pkg/rustd-serial-grok-bulk-7` @ `0a51358` | rustd-serial follow-up | build + 30 tests pass (XML Decode schema vs Go Unmarshal) | `ccb0a37` |
| `pkg/rustd-archive-grok-bulk-6` @ `ee92b1d` | rustd-archive follow-up | build + 38 tests pass (was 18; pax mtime fractional + UnixMilli fixtures) | `1295731` |

### Rejected

- `pkg/rustd-mathx-grok-bulk-10` @ `efd0592` — **build+test green** (32 tests) but `git merge --no-ff` conflicted. `git merge --abort`. Not merged.
  First 40 lines of conflict:

```
Auto-merging pnpm-lock.yaml
CONFLICT (content): Merge conflict in pnpm-lock.yaml
Automatic merge failed; fix conflicts and then commit the result.
--- conflicted files ---
pnpm-lock.yaml
--- importers on origin/main (bfdd10f) ---
  packages/_template: {}
  packages/rustd-crypto: {}
  packages/rustd-log: {}
--- importers on mathx branch ---
  packages/_template: {}
  packages/rustd-crypto: {}
  packages/rustd-mathx: {}
```

  Cause: mathx merge-base is `de3e643` (archive merge, pre-log). After `rustd-log` landed, both sides add a different `importers` entry. Worker should rebase onto current `origin/main` and re-push. Newer tip `a8246ba` (JS state() UnmarshalBinary) is a descendant of `efd0592` and still conflicts.

- `pkg/rustd-encoding-grok-bulk-2` @ `b5f930e` — same SHA as last round; still lockfile conflict. Not re-verified.
- `pkg/rustd-mime-grok-bulk-3` — still lockfile conflict (tip moved `ca892a9` → `0660cea`, merge-base still `0da14ff`). Not re-verified this round.
- `pkg/rustd-testing-grok-bulk-6` — `rejected-by-owner` (issue #20). Skipped.
- `pkg/rustd-debugfmt-grok-bulk-5` — `rejected-by-owner` (issue #18). Skipped.

### Superseded / do-not-merge

- `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — still superseded by `pkg/rustd-image-grok-bulk-8`.

### Not processed this round (oldest first; max 3 packages/round)

1. `pkg/rustd-image-grok-bulk-2` (`d9c447c`) — skip; superseded
2. `pkg/rustd-testing-grok-bulk-6` (`9fc9508`) — skip; rejected-by-owner
3. `pkg/rustd-encoding-grok-bulk-2` (`b5f930e`) — waiting on rebase after lockfile conflict
4. `pkg/rustd-image-grok-bulk-8` follow-up `ee6301c` — safe (`ac8f590` is ancestor)
5. `pkg/rustd-containers-grok-bulk-2` follow-up `b672b3f` — safe (`7ed487b` is ancestor)
6. `pkg/rustd-compress-grok-bulk-9` follow-up `b692e78` — safe (`4af21a6` is ancestor)
7. `pkg/rustd-debugfmt-grok-bulk-5` (`2e5197c`) — skip; rejected-by-owner
8. `pkg/rustd-mail-grok-bulk-worker` (`2852022`) — worker in progress; merge-tree CLEAN
9. `pkg/rustd-mathx-grok-bulk-10` newer `a8246ba` — waiting on rebase
10. `pkg/rustd-regexsyntax-grok-bulk-7` (`872f779`) — merge-tree CLEAN; after owner-12 first-time
11. `pkg/rustd-mime-grok-bulk-3` (`0660cea`) — waiting on rebase
12. `pkg/rustd-gotool-grok-bulk-4` follow-up `bb6a034` — safe

Suggested next three: encoding/mime/mathx **after rebase onto origin/main**. If still un-rebased, take oldest safe follow-ups: image `ee6301c`, containers `b672b3f`, compress `b692e78`. `rustd-regexsyntax` is merge-tree CLEAN but wait until the remaining 3 of the owner 12 land (or stay blocked on rebase).

### Notes

- Owner skip list still in force: `pkg/rustd-testing-*` (#20), `pkg/rustd-std-*` (#29), `pkg/rustd-debugfmt-*` (#18).
- First-time remaining of the owner 12: `encoding`, `mime`, `mathx` — all blocked on `pnpm-lock.yaml` importer conflict vs `rustd-log`. Workers must rebase onto current `origin/main`.
- On main now: crypto, checksum, containers, compress, archive, serial, image, log, unicode, gotool. Missing from the 12: encoding, mime, mathx.
- `main` is locked in `~/Developer/rustd-js`; this worktree merges on `grok-integrator-main` and `git push origin grok-integrator-main:main`.
- `CI=false` on `--filter` builds. Lockfile drift discarded, not committed.
- Builds: `CARGO_BUILD_JOBS=2 nice -n 10 pnpm --filter rustd-<x> {build,test}`.
- Go via `mise` (go1.24.13). Rust 1.97.1. Node v24.20.0.
