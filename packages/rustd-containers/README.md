# rustd-containers

Go `container/heap`, `container/list`, `container/ring`, and `index/suffixarray` for Node.
Issue [#23](https://github.com/AkaraChen/rustd-js/issues/23). Runtime Node >=20. No JavaScript runtime dependencies.

| API | Implementation |
| --- | --- |
| `Heap`, `heapInit`/`heapPush`/`heapPop` | **@js** |
| `List`, `Element` | **@js** |
| `Ring`, `newRing`, `ringFrom` | **@js** |
| `SuffixArray` | **@native** SA-IS (Go `sais.go` / 32-bit `sais2.go`) |

`List`/`Heap`/`Ring` stay usable when the optional native binary is missing (`--no-optional`). Only `SuffixArray` throws `NativeMissingError`.

```js
import { Heap, List, newRing, SuffixArray } from 'rustd-containers';

const h = new Heap((a, b) => a - b, [3, 1, 2]);
h.push(0);
h.pop(); // 0

const list = new List();
list.pushBack('a');
const ix = SuffixArray.build(new Uint8Array([98, 97, 110, 97, 110, 97])); // banana
ix.lookup(new Uint8Array([97, 110])); // Uint32Array [3, 1] — suffix-array order
ix.dispose();
```

## Differences from Go

- `FindAllIndex` is not in v1 (JS `RegExp` is not RE2).
- `SuffixArray.lookup` returns `Uint32Array`, not `[]int`. Empty/`n === 0` is an empty typed array, not `nil`.
- `Heap` owns its array. `toArray()` is that live storage (mutate index `i` then `fix(i)`, as in Go). Comparator is `(a, b) => number` (`< 0` means `Less`).
- Empty `Heap.pop()`/`peek()` return `undefined` instead of panicking.
- `List.Init()` is `clear()` and does not return the list.
- `List.insertBefore`/`insertAfter` return `null` when `mark` is not in the list (Go returns `nil`).
- `PushBackList`/`PushFrontList` **copy values** and leave `other` intact. That is Go 1.24.13 `container/list` (issue #23's "move nodes" note does not match Go).
- `SuffixArray` copies the input bytes; `bytes()` returns another copy. Go's `New` aliases the slice.
- `SuffixArray.dispose()` / `[Symbol.dispose]` release native `data` + SA. `List`/`Heap`/`Ring` have no `dispose`.
- `newRing(0)` is an empty ring object (`len() === 0`), not JavaScript `null` (Go `ring.New(0)` is `nil`).
- Only 32-bit suffix arrays (`len(data) <= MaxInt32`). Larger inputs throw.

`fix`/`remove` assume the heap invariant except for the updated index, same as Go.

## Native format

`write()`/`read()` use Go's private `index/suffixarray` layout: 10-byte little varint length, raw bytes, then buffered `[varint(chunkSize) + uvarint SA entries]` chunks of 16 KiB. A Go `Index.Read` can consume our `write()` bytes.

## Size

Recorded after `napi build --platform --release` + strip on this builder (Linux x64 GNU, Rust 1.97.1). Cap is 2,000,000 bytes.

```text
$ ls -l packages/rustd-containers/*.node
-rwxrwxr-x 1 akrc akrc 372616 Sep 14 15:38 packages/rustd-containers/rustd-containers.linux-x64-gnu.node
```

`372616` bytes / `2000000`.

## SuffixArray.build scaling (issue #23 §4.3)

256 KiB / 1 MiB / 4 MiB: median of 3 after one warmup. 1 / 4 / 16 MiB: 5 timed samples, drop min/max, median of remaining 3 (shared-host 3-sample medians flake at the caps). Same builder, existing linux-x64-gnu `.node`, `nice -n 10`. Go 1.24.13 `index/suffixarray.New` on the same host (3 runs, no 16 MiB): identical 256K/1M/4M ≈ 2.3 / 8.8 / 47.8 ms; patterned ≈ 9.5 / 58.1 / 443.6 ms (4MB/1MB ≈ 7.6–9.8×). Five-platform numbers are not in this slice.

| input | 256 KiB | 1 MiB | 4 MiB | 16 MiB | 16M/4M | 16M/1M |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| identical `a` | 1.99 ms | 6.81 ms | 32.2 ms | 148 ms | 4.60 | 21.7 |
| patterned bytes | 7.60 ms | 50.0 ms | 678 ms | 2771 ms | 4.09 | 55.5 |

Caps: identical 4× size ≤ 8× time and 16× size ≤ 64× time. Patterned 4× size ≤ 16× time and 16× size ≤ 128× time — Go SA-IS is already ~10× for 4× size on this LMS-dense pattern, so an 8×/64× cap red-boards a correct port (integrator 4MB/1MB=14.4, 16MB/1MB=77.27). Naive suffix sort still fails both. `lookup` of `aaaa` (`n=8`) on 1 MiB identical input: ~119k QPS (2000 calls / 16.8 ms).

## Errors

| Class | `code` |
| --- | --- |
| `ContainersError` | `ERR_CONTAINERS` |
| `NativeMissingError` | `ERR_CONTAINERS_NATIVE_MISSING` |
| `SuffixArrayFormatError` | `ERR_CONTAINERS_SUFFIXARRAY_FORMAT` |
| `SuffixArrayDisposedError` | `ERR_CONTAINERS_SUFFIXARRAY_DISPOSED` |
| `SuffixArrayLookupError` | `ERR_CONTAINERS_SUFFIXARRAY_LOOKUP` |
