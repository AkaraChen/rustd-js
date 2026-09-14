'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-containers';
let platform = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') {
  if (!process.report.getReport().header.glibcVersionRuntime) {
    throw new Error(`${name}: Linux musl is not supported`);
  }
  platform += '-gnu';
} else if (process.platform === 'win32') platform += '-msvc';
if (!['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'].includes(platform)) {
  throw new Error(`${name}: unsupported platform ${platform}`);
}

let binding = null;
let nativeLoadError = null;
const local = join(__dirname, `${name}.${platform}.node`);
if (existsSync(local)) {
  try { binding = require(local); } catch (cause) { nativeLoadError = cause; }
} else {
  try { binding = require(`${name}-${platform}`); } catch (cause) { nativeLoadError = cause; }
}

class ContainersError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_CONTAINERS';
}
class NativeMissingError extends ContainersError { static code = 'ERR_CONTAINERS_NATIVE_MISSING'; }
class SuffixArrayFormatError extends ContainersError { static code = 'ERR_CONTAINERS_SUFFIXARRAY_FORMAT'; }
class SuffixArrayDisposedError extends ContainersError { static code = 'ERR_CONTAINERS_SUFFIXARRAY_DISPOSED'; }
class SuffixArrayLookupError extends ContainersError { static code = 'ERR_CONTAINERS_SUFFIXARRAY_LOOKUP'; }

const errors = { NativeMissingError, SuffixArrayFormatError, SuffixArrayDisposedError, SuffixArrayLookupError };

function native(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const colon = msg.indexOf(':');
    const kind = colon === -1 ? msg : msg.slice(0, colon);
    const rest = colon === -1 ? msg : msg.slice(colon + 2);
    throw new (errors[kind] ?? ContainersError)(rest || msg, { cause });
  }
}
function nativeMust() {
  if (!binding) {
    throw new NativeMissingError('rustd-containers: native extension missing (SuffixArray only)', { cause: nativeLoadError });
  }
}
function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('containers: expected Uint8Array');
  }
  return value;
}
function intIndex(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`containers: ${label} must be an integer`);
  }
  return value;
}

class Heap {
  constructor(compare, values) {
    if (typeof compare !== 'function') throw new TypeError('containers: compare must be a function');
    if (values !== undefined && !Array.isArray(values) && !ArrayBuffer.isView(values) && (typeof values.length !== 'number' || typeof values[Symbol.iterator] !== 'function')) {
      throw new TypeError('containers: values must be an array-like sequence');
    }
    this._compare = compare;
    this._data = values === undefined ? [] : Array.from(values);
    heapify(this);
  }
  get length() { return this._data.length; }
  push(value) {
    this._data.push(value);
    up(this, this._data.length - 1);
  }
  pop() {
    const n = this._data.length;
    if (n === 0) return undefined;
    swap(this, 0, n - 1);
    const value = this._data.pop();
    down(this, 0, n - 1);
    return value;
  }
  peek() { return this._data[0]; }
  fix(index) {
    const i = checkIndex(this, index);
    if (!down(this, i, this._data.length)) up(this, i);
  }
  remove(index) {
    const i = checkIndex(this, index);
    const n = this._data.length - 1;
    if (n !== i) {
      swap(this, i, n);
      if (!down(this, i, n)) up(this, i);
    }
    return this._data.pop();
  }
  toArray() { return this._data; }
  [Symbol.iterator]() { return this._data[Symbol.iterator](); }
}
function less(h, i, j) { return h._compare(h._data[i], h._data[j]) < 0; }
function swap(h, i, j) { const t = h._data[i]; h._data[i] = h._data[j]; h._data[j] = t; }
function up(h, j) {
  for (;;) {
    const i = (j - 1) >> 1;
    if (i === j || !less(h, j, i)) break;
    swap(h, i, j);
    j = i;
  }
}
function down(h, i0, n) {
  let i = i0;
  for (;;) {
    const j1 = 2 * i + 1;
    if (j1 >= n || j1 < 0) break;
    let j = j1;
    if (j1 + 1 < n && less(h, j1 + 1, j1)) j = j1 + 1;
    if (!less(h, j, i)) break;
    swap(h, i, j);
    i = j;
  }
  return i > i0;
}
function heapify(h) {
  const n = h._data.length;
  for (let i = (n >> 1) - 1; i >= 0; i--) down(h, i, n);
}
function checkIndex(h, index) {
  const i = intIndex(index, 'index');
  if (i < 0 || i >= h._data.length) throw new RangeError('containers: heap index out of range');
  return i;
}
function heapInit(heap) { heapify(heap); }
function heapPush(heap, value) { heap.push(value); }
function heapPop(heap) { return heap.pop(); }

class Element {
  constructor(value) {
    this.value = value;
    this._next = null;
    this._prev = null;
    this._list = null;
  }
  get next() {
    const p = this._next;
    return this._list != null && p !== this._list._root ? p : null;
  }
  get prev() {
    const p = this._prev;
    return this._list != null && p !== this._list._root ? p : null;
  }
}

class List {
  constructor() {
    this._root = new Element(undefined);
    this._root._next = this._root;
    this._root._prev = this._root;
    this._len = 0;
  }
  get length() { return this._len; }
  front() { return this._len === 0 ? null : this._root._next; }
  back() { return this._len === 0 ? null : this._root._prev; }
  _insert(e, at) {
    e._prev = at;
    e._next = at._next;
    e._prev._next = e;
    e._next._prev = e;
    e._list = this;
    this._len++;
    return e;
  }
  _insertValue(value, at) { return this._insert(new Element(value), at); }
  _remove(e) {
    e._prev._next = e._next;
    e._next._prev = e._prev;
    e._next = null;
    e._prev = null;
    e._list = null;
    this._len--;
  }
  _move(e, at) {
    if (e === at) return;
    e._prev._next = e._next;
    e._next._prev = e._prev;
    e._prev = at;
    e._next = at._next;
    e._prev._next = e;
    e._next._prev = e;
  }
  pushFront(value) { return this._insertValue(value, this._root); }
  pushBack(value) { return this._insertValue(value, this._root._prev); }
  insertBefore(value, mark) {
    if (!(mark instanceof Element) || mark._list !== this) return null;
    return this._insertValue(value, mark._prev);
  }
  insertAfter(value, mark) {
    if (!(mark instanceof Element) || mark._list !== this) return null;
    return this._insertValue(value, mark);
  }
  moveToFront(e) {
    if (!(e instanceof Element) || e._list !== this || this._root._next === e) return;
    this._move(e, this._root);
  }
  moveToBack(e) {
    if (!(e instanceof Element) || e._list !== this || this._root._prev === e) return;
    this._move(e, this._root._prev);
  }
  moveBefore(e, mark) {
    if (!(e instanceof Element) || !(mark instanceof Element) || e._list !== this || e === mark || mark._list !== this) return;
    this._move(e, mark._prev);
  }
  moveAfter(e, mark) {
    if (!(e instanceof Element) || !(mark instanceof Element) || e._list !== this || e === mark || mark._list !== this) return;
    this._move(e, mark);
  }
  remove(e) {
    if (!(e instanceof Element)) throw new TypeError('containers: expected Element');
    if (e._list === this) this._remove(e);
    return e.value;
  }
  clear() {
    this._root._next = this._root;
    this._root._prev = this._root;
    this._len = 0;
  }
  // Go copies values (container/list.PushBackList). Issue #23's "move" wording is incorrect vs Go 1.24.13.
  pushBackList(other) {
    if (!(other instanceof List)) throw new TypeError('containers: expected List');
    for (let i = other._len, e = other.front(); i > 0; i--, e = e.next) this._insertValue(e.value, this._root._prev);
  }
  pushFrontList(other) {
    if (!(other instanceof List)) throw new TypeError('containers: expected List');
    for (let i = other._len, e = other.back(); i > 0; i--, e = e.prev) this._insertValue(e.value, this._root);
  }
  toArray() {
    const out = [];
    for (let e = this.front(); e; e = e.next) out.push(e.value);
    return out;
  }
  *[Symbol.iterator]() {
    for (let e = this.front(); e; e = e.next) yield e.value;
  }
}

class Ring {
  constructor() {
    this.value = undefined;
    this._next = this;
    this._prev = this;
    this._empty = false;
  }
  next() {
    if (this._empty) throw new TypeError('containers: empty ring');
    if (this._next == null) return this._init();
    return this._next;
  }
  prev() {
    if (this._empty) throw new TypeError('containers: empty ring');
    if (this._next == null) return this._init();
    return this._prev;
  }
  _init() {
    this._next = this;
    this._prev = this;
    return this;
  }
  move(n) {
    if (this._empty) throw new TypeError('containers: empty ring');
    n = intIndex(n, 'n');
    let r = this._next == null ? this._init() : this;
    if (n < 0) {
      while (n < 0) { r = r._prev; n++; }
    } else if (n > 0) {
      while (n > 0) { r = r._next; n--; }
    }
    return r;
  }
  link(s) {
    if (this._empty) throw new TypeError('containers: empty ring');
    const n = this.next();
    if (s != null && s instanceof Ring && !s._empty) {
      const p = s.prev();
      this._next = s;
      s._prev = this;
      n._prev = p;
      p._next = n;
    }
    return n;
  }
  unlink(n) {
    if (this._empty) throw new TypeError('containers: empty ring');
    n = intIndex(n, 'n');
    if (n <= 0) return emptyRing();
    return this.link(this.move(n + 1));
  }
  len() {
    if (this._empty || this == null) return 0;
    let n = 1;
    for (let p = this.next(); p !== this; p = p._next) n++;
    return n;
  }
  do(f) {
    if (typeof f !== 'function') throw new TypeError('containers: callback must be a function');
    if (this._empty) return;
    f(this.value);
    for (let p = this.next(); p !== this; p = p._next) f(p.value);
  }
}

function emptyRing() {
  const r = new Ring();
  r._empty = true;
  r._next = null;
  r._prev = null;
  return r;
}

function newRing(n) {
  n = intIndex(n, 'n');
  if (n <= 0) return emptyRing();
  const r = new Ring();
  let p = r;
  for (let i = 1; i < n; i++) {
    p._next = new Ring();
    p._next._prev = p;
    p = p._next;
  }
  p._next = r;
  r._prev = p;
  return r;
}

function ringFrom(values) {
  if (values == null || typeof values[Symbol.iterator] !== 'function') {
    throw new TypeError('containers: values must be iterable');
  }
  const items = Array.from(values);
  if (items.length === 0) return emptyRing();
  const r = newRing(items.length);
  let p = r;
  for (const value of items) {
    p.value = value;
    p = p._next;
  }
  return r;
}

class SuffixArray {
  constructor(handle) { this._native = handle; }
  _handle() {
    if (!this._native) throw new SuffixArrayDisposedError('suffixarray: index has been disposed');
    return this._native;
  }
  static build(data) {
    nativeMust();
    return new SuffixArray(native(() => binding.NativeSuffixArray.build(bytes(data))));
  }
  static read(input) {
    nativeMust();
    return new SuffixArray(native(() => binding.NativeSuffixArray.read(bytes(input))));
  }
  get length() { return native(() => this._handle().length); }
  bytes() { return native(() => this._handle().bytes()); }
  lookup(query, n) {
    if (n === undefined) n = -1;
    if (typeof n !== 'number' || !Number.isInteger(n) || (n < 0 && n !== -1)) {
      throw new SuffixArrayLookupError('suffixarray: n must be -1 or a non-negative integer');
    }
    return native(() => this._handle().lookup(bytes(query), n));
  }
  write() { return native(() => this._handle().write()); }
  dispose() {
    if (this._native) native(() => this._native.dispose());
    this._native = null;
  }
  [Symbol.dispose]() { this.dispose(); }
}

module.exports = {
  ContainersError, NativeMissingError, SuffixArrayFormatError, SuffixArrayDisposedError, SuffixArrayLookupError,
  Heap, heapInit, heapPush, heapPop,
  Element, List,
  Ring, newRing, ringFrom,
  SuffixArray,
};
