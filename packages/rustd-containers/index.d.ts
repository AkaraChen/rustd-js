/** @js Compare like `Array.sort`: <0 means `a` precedes `b`. */
export type Comparator<T> = (a: T, b: T) => number;

/** @js Min-heap holding its own array. `compare` is Go `Less` as a numeric comparator. */
export class Heap<T> {
  constructor(compare: Comparator<T>, values?: readonly T[]);
  push(value: T): void;
  pop(): T | undefined;
  peek(): T | undefined;
  /** @js Go `heap.Fix`. */
  fix(index: number): void;
  /** @js Go `heap.Remove`. Out-of-range throws `RangeError`. */
  remove(index: number): T;
  /** @js Live internal heap array (not sorted). Mutate index i then `fix(i)`, as in Go. */
  toArray(): T[];
  get length(): number;
  [Symbol.iterator](): IterableIterator<T>;
}
/** @js Go `heap.Init`. */
export function heapInit<T>(heap: Heap<T>): void;
/** @js Go `heap.Push`. */
export function heapPush<T>(heap: Heap<T>, value: T): void;
/** @js Go `heap.Pop`. */
export function heapPop<T>(heap: Heap<T>): T | undefined;

/** @js Go `list.Element`. `next`/`prev` skip the internal sentinel. */
export class Element<T> {
  value: T;
  readonly next: Element<T> | null;
  readonly prev: Element<T> | null;
}

/** @js Doubly linked list. Go `container/list`. */
export class List<T> {
  constructor();
  get length(): number;
  front(): Element<T> | null;
  back(): Element<T> | null;
  pushFront(value: T): Element<T>;
  pushBack(value: T): Element<T>;
  insertBefore(value: T, mark: Element<T>): Element<T> | null;
  insertAfter(value: T, mark: Element<T>): Element<T> | null;
  moveToFront(e: Element<T>): void;
  moveToBack(e: Element<T>): void;
  moveBefore(e: Element<T>, mark: Element<T>): void;
  moveAfter(e: Element<T>, mark: Element<T>): void;
  /** @js Go `Remove`: if `e` is not in this list, still returns `e.value`. */
  remove(e: Element<T>): T;
  /** @js Go `Init`. */
  clear(): void;
  /** @js Go `PushBackList`: copies values; `other` is unchanged. */
  pushBackList(other: List<T>): void;
  /** @js Go `PushFrontList`: copies values; `other` is unchanged. */
  pushFrontList(other: List<T>): void;
  [Symbol.iterator](): IterableIterator<T>;
  toArray(): T[];
}

/** @js Circular list node. Go `container/ring`. */
export class Ring<T> {
  value: T;
  next(): Ring<T>;
  prev(): Ring<T>;
  move(n: number): Ring<T>;
  link(s: Ring<T>): Ring<T>;
  unlink(n: number): Ring<T>;
  len(): number;
  do(f: (value: T) => void): void;
}
/** @js Go `ring.New`. `n <= 0` is an empty ring (`len() === 0`). */
export function newRing<T>(n: number): Ring<T>;
export function ringFrom<T>(values: readonly T[]): Ring<T>;

export class ContainersError extends Error { readonly code: string }
export class NativeMissingError extends ContainersError {}
export class SuffixArrayFormatError extends ContainersError {}
export class SuffixArrayDisposedError extends ContainersError {}
export class SuffixArrayLookupError extends ContainersError {}

/** @native SA-IS suffix array. Input bytes are copied. */
export class SuffixArray {
  static build(data: Uint8Array): SuffixArray;
  /** @native Go `Lookup`. Order is suffix-array order, not sorted. `n` omitted or `-1` means all. */
  lookup(s: Uint8Array, n?: number): Uint32Array;
  /** @native Go private `Write` bytes. */
  write(): Uint8Array;
  /** @native Go `Read`. */
  static read(bytes: Uint8Array): SuffixArray;
  readonly length: number;
  bytes(): Uint8Array;
  dispose(): void;
  [Symbol.dispose](): void;
}
