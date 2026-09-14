# WinterTC 清单：ECMA-429《Minimum common web API》

## 这是什么

- **谁出的**：Ecma International **TC55**（对外叫 WinterTC，原名 WinterCG）。成员是 Cloudflare / Deno / Node / Bun / Fastly / Vercel 这些服务端 JS 运行时的厂商。
- **标准号**：**ECMA-429**，标题《Minimum common web API》，**第 1 版 = 2025 快照**，2025 年 12 月 Ecma 大会通过（年更节奏）。
- **干嘛用**：定义一份"浏览器和服务端运行时**共有**的 Web 平台 API 最小集合"，让同一份代码在浏览器 / Node / Deno / Bun / workerd 之间可移植。
- **强制范围**：§2 规定符合本标准的运行时**还必须符合 ECMA-262**。所以 `JSON`、`Math`、`BigInt`、`RegExp`、`Proxy`/`Reflect`、`Atomics`、`WeakRef` 这些**语言层**能力不在清单里也是强制的。
- **官方地址**：
  - 规范正文 https://min-common-api.proposal.wintertc.org/
  - 源文件仓库 https://github.com/wintercg/proposal-common-minimum-api （本目录 `raw/ecma-429-index.bs`，sha256 `f5f9d4034879d0c878fc1a9351146d53460253e73f949f77e15fa0dee0ace9eb`，抓取于 2026-09-14）

> 注意：TC55 口径里**只有这一份"最小公共 API"清单**。网上流传的旧版 wintercg README 大表格就是它被 Ecma 收编前的草稿；现在没有另一份官方"recommended 列表"。
> 另外 TC55 正在推进一些**补充标准**（不是最小集的一部分），目前仓库里能看到的是 **AsyncLocalStorage**（上下文传播的可移植子集，`raw/wintertc-asynclocalstorage.md`）。

## 完整条目（73 项）

### §5.1 必须在 `globalThis` 上暴露的接口（53 个）

**DOM Standard**
`AbortController` `AbortSignal` `Event` `EventTarget`

**HTML Standard**
`CustomEvent` `ErrorEvent` `MessageChannel` `MessageEvent` `MessagePort` `PromiseRejectionEvent`

**Web IDL**
`DOMException`

**Fetch Standard**
`Headers` `Request` `Response`

**XMLHttpRequest Standard**
`FormData`

**File API**
`Blob` `File`

**Compression Standard**
`CompressionStream` `DecompressionStream`

**Streams Standard**
`ByteLengthQueuingStrategy` `CountQueuingStrategy` `ReadableByteStreamController` `ReadableStream` `ReadableStreamBYOBReader` `ReadableStreamBYOBRequest` `ReadableStreamDefaultController` `ReadableStreamDefaultReader` `TransformStream` `TransformStreamDefaultController` `WritableStream` `WritableStreamDefaultController` `WritableStreamDefaultWriter`

**Encoding Standard**
`TextDecoder` `TextDecoderStream` `TextEncoder` `TextEncoderStream`

**URL Standard**
`URL` `URLSearchParams`

**URL Pattern Standard**
`URLPattern`

**Web Cryptography Level 2**
`Crypto` `CryptoKey` `SubtleCrypto`

**High Resolution Time**
`Performance`

**WebAssembly JavaScript Interface**
`WebAssembly.Global` `WebAssembly.Instance` `WebAssembly.Memory` `WebAssembly.Module` `WebAssembly.Table` `WebAssembly.Tag` `WebAssembly.Exception` `WebAssembly.CompileError` `WebAssembly.LinkError` `WebAssembly.RuntimeError`

### §5.2 必须在 `globalThis` 上暴露的方法与属性（20 项）

**ECMAScript**
`globalThis`

**HTML Standard**
`navigator.userAgent` `onerror` `onunhandledrejection` `onrejectionhandled` `self`
`atob()` `btoa()` `setTimeout()` `clearTimeout()` `setInterval()` `clearInterval()` `queueMicrotask()` `reportError()` `structuredClone()`

**Fetch Standard**
`fetch()`

**Console Standard**
`console`

**Web Cryptography Level 2**
`crypto`

**High Resolution Time**
`performance`

**WebAssembly JavaScript Interface**
`WebAssembly.compile()` `WebAssembly.compileStreaming()` `WebAssembly.instantiate()` `WebAssembly.instantiateStreaming()` `WebAssembly.validate()` `WebAssembly.JSTag`

### §5.3 Web Workers —— **不强制**（条件性要求）

规范明确说：**运行时不要求支持 Web Workers**。只有当运行时存在映射到 `WorkerGlobalScope` 的全局作用域时，才额外要求 `onerror` / `onunhandledrejection` / `onrejectionhandled` / `self`。

### §6 全局作用域

不要求实现 `Window` / `WorkerGlobalScope` 这类浏览器全局接口，允许运行时把 `globalThis` 映射到自己的全局作用域类型；若因历史原因无法让全局对象是 `EventTarget` 实例，则必须用等价机制派发同样的信息（且此时可以不实现 `ErrorEvent` / `PromiseRejectionEvent`）。

### §7 默认 `User-Agent`

要求提供一个符合 RFC 7231 `product` 构造的字符串，且**应当**是单个 `product` token（不含版本、不含 comment），让应用代码能可靠识别运行时。例：`navigator.userAgent === 'MyRuntime'`。

## 值得注意的"没写进去"

最小集**刻意不含**（但 Web 平台本身有）：`WebSocket`、`EventSource`、`BroadcastChannel`、`WebStorage/localStorage`、`IndexedDB`、`Cookies`、`WebTransport`、`Canvas`/`OffscreenCanvas`、`ImageDecoder`/WebCodecs、`DOMParser`、`DOMParser` 之外的 DOM 树、`PerformanceObserver`、`Intl`（在 ECMA-402）、`Date`（在 ECMA-262）、`Web Locks`、`SharedArrayBuffer` 之外的共享内存面、任何文件系统 API（File System Standard / OPFS）、任何网络服务端 API（`listen`/`serve`）。
