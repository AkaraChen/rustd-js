# Go 标准库 × WinterTC（ECMA-429 最小公共 API）对照与缺口

生成时间：2026-09-14 · Go 侧 `go1.25.6 darwin/arm64` · WinterTC 侧 ECMA-429 第 1 版（2025 快照）

---

## 一句话结论

**Go 标准库 173 个包（去掉 internal/vendor/cmd）对照 WinterTC 最小公共 API：11 个有直接对应、45 个只有很窄的对应、117 个完全没有。**

但这个数字**不能理解成"WinterTC 很差"**——两边根本不是同一层东西：

- **Go 标准库 = 语言自带电池**：面向"一个进程能独立干完所有活"，所以有文件系统、TCP/UDP、HTTP 服务端、子进程、信号、TLS、证书、归档、图像、测试框架、编译器前端。
- **WinterTC 最小集 = 跨运行时的互操作底线**：只规定"浏览器和服务端 JS 运行时**共有**"的那一层（fetch / URL / Streams / WebCrypto / Wasm / 编码 / 控制台 / 定时器），外加 §2 强制符合 ECMA-262（语言层能力）。
- **平台差异大的能力被故意排除**，留给各运行时私有扩展（`node:fs`、`Deno.serve`、`Bun.serve`…）。

所以本报告的准确读法是：**这 117 项能力永远不会通过 WinterTC 获得互操作性，跨运行时只能指望各自的私有 API 或生态包。**

---

## 1. 数据来源与口径

| | Go 侧 | WinterTC 侧 |
| --- | --- | --- |
| 来源 | `go list std` | ECMA-429 规范源 `index.bs` |
| 过滤 | 去掉 `internal/**`、`vendor/**`、`cmd/**` | 无，全量 |
| 数量 | **173** 个包（含子包；`go list std` 原始 349 个） | **73** 项（§5.1 接口 53 + §5.2 方法与属性 20） |
| 冻结 | go1.25.6 | `sha256 f5f9d4034879d0c878fc1a9351146d53460253e73f949f77e15fa0dee0ace9eb` |

- WinterTC 侧完整条目 → [`list-wintertc-ecma-429.md`](list-wintertc-ecma-429.md)
- Go 侧完整清单（带一句话简介）→ [`list-go-stdlib.md`](list-go-stdlib.md)
- 逐包对照（173 行）→ [`go-stdlib-vs-wintertc.csv`](go-stdlib-vs-wintertc.csv)
- 只看缺口（162 行）→ [`gaps-only.csv`](gaps-only.csv)
- 缺口按类别整理成文 → [`missing-in-wintertc.md`](missing-in-wintertc.md)

判定标准（"对应"按**能力**算，不按名字算）：

- ✅ **覆盖** = 最小集里有条目能直接承担该能力（含由 ECMA-262 语言层强制承担的情况）
- 🟡 **部分** = 有对应条目但能力明显更窄（一次性 vs 流式、只有客户端 vs 也要服务端、单算法 vs 全算法、只有异步流 vs 也要同步 IO）
- ❌ **缺失** = 最小集里完全没有对应条目

---

## 2. 统计

| 状态 | 包数 | 占比 |
| --- | --- | --- |
| ✅ 覆盖 | 11 | 6.4% |
| 🟡 部分 | 45 | 26.0% |
| ❌ 缺失 | 117 | 67.6% |

按能力域（覆盖 / 部分 / 缺失）：

| 能力域 | 覆盖 | 部分 | 缺失 | 合计 |
| --- | --- | --- | --- | --- |
| 加解密 | 1 | 16 | 15 | 32 |
| 基础与语言层 | 5 | 17 | 5 | 27 |
| 编码与序列化 | 1 | 5 | 9 | 15 |
| 网络 | 1 | 1 | 13 | 15 |
| 工具链与元编程 | 0 | 0 | 14 | 14 |
| 诊断与可观测 | 0 | 2 | 10 | 12 |
| 并发与运行时 | 0 | 1 | 9 | 10 |
| 压缩与归档 | 3 | 0 | 4 | 7 |
| 图像 | 0 | 0 | 7 | 7 |
| 进程与系统 | 0 | 0 | 6 | 6 |
| 文本与模板 | 0 | 0 | 6 | 6 |
| 测试 | 0 | 0 | 6 | 6 |
| 文件系统与路径 | 0 | 0 | 4 | 4 |
| 容器与算法 | 0 | 0 | 4 | 4 |
| 字节与流 | 0 | 2 | 2 | 4 |
| 数据与持久化 | 0 | 0 | 2 | 2 |
| 时间与本地化 | 0 | 1 | 1 | 2 |

**11 个"完全覆盖"是哪些**：`math`、`math/big`、`regexp`、`errors`、`weak`（这五个靠 ECMA-262 语言层强制）、`encoding/json`、`crypto/rand`、`compress/flate`、`compress/gzip`、`compress/zlib`、`net/url`。

---

## 3. ❌ 完全缺失的清单（117 项，按能力域）

> 逐条说明在 [`missing-in-wintertc.md`](missing-in-wintertc.md)。这里给结论级摘要 + 该能力实际落在哪。

| 能力域 | 缺什么（Go 包） | WinterTC 里为什么没有 | 现实里谁提供 |
| --- | --- | --- | --- |
| **文件系统与路径** | `io/fs` `path` `path/filepath` `embed` `plugin` | File System Standard / OPFS 未被列入；路径不是 Web 概念 | `node:fs` / `node:path`、`Deno.readFile/Deno.open`、`Bun.file` |
| **网络（服务端与传输层）** | `net` `net/http`（服务端侧）`net/http/{cgi,fcgi,httptest,httputil,cookiejar,httptrace,pprof}` `net/{mail,smtp,netip,textproto,rpc,rpc/jsonrpc}` | 最小集只规定**客户端** `fetch`；`listen`/`serve`/socket 是运行时形态差异最大的部分 | `node:net`/`node:http`、`Deno.serve`、`Bun.serve`；邮件/RPC 只能靠生态包 |
| **进程与系统** | `os` `os/exec` `os/signal` `os/user` `syscall` `flag` | 无进程模型概念（浏览器没有） | `node:process`/`node:child_process`、`Deno.Command`、`Bun.spawn` |
| **并发与运行时** | `sync` `runtime` `runtime/{cgo,coverage,debug,metrics,pprof,race,trace}` | §5.3 明确**不要求** Web Workers；无锁/线程概念 | `node:worker_threads` + `Atomics`（ECMA-262）；GC/剖析属运行时私有 |
| **加解密（广度）** | `crypto/tls` `crypto/x509(+pkix)` `crypto/{des,dsa,rc4}` `crypto/md5` `hash` `hash/{adler32,crc32,crc64,fnv,maphash}` | WebCrypto 只收现代算法，且**不暴露 TLS/证书配置面**；非密码学校验和不在其范围 | `node:crypto`、`Bun.CryptoHasher`、生态包（TLS 面：`node:tls`、`Deno.connectTls`） |
| **编码与序列化** | `encoding/{base32,hex,csv,xml,gob,pem,asn1,ascii85}` `mime/quotedprintable` | 只标准化了 UTF-8/UTF-16 文本编解码与 JSON（语言层）；格式类编码都算生态 | npm 生态（`csv-parse`、`fast-xml-parser`…）；PEM/ASN.1/证书解析基本只在 `node:crypto` 里 |
| **压缩与归档** | `compress/{bzip2,lzw}` `archive/{tar,zip}` | Compression Standard 只枚举 gzip / deflate / deflate-raw | 生态包（`tar-stream`、`fflate`…） |
| **工具链与元编程** | `go/*` 全部 14 个（parser/ast/types/format/build/scanner…）、`regexp/syntax`、`unsafe` | 没有任何"编译器前端 API"被标准化 | TypeScript / Babel / oxc 等生态工具 |
| **诊断与可观测** | `log/syslog` `expvar` `net/http/pprof` `debug/{dwarf,elf,gosym,macho,pe,plan9obj}` | 可观测性没有平台约定（console 是唯一被要求的输出面） | OpenTelemetry 生态 + 运行时私有剖析开关（`--cpu-prof` 等） |
| **图像** | `image` `image/color(+palette)` `image/draw` `image/{gif,jpeg,png}` | ImageDecoder / WebCodecs / Canvas **都不在最小集** | 浏览器侧是 Canvas；服务端靠生态（sharp / jimp） |
| **文本与模板** | `html` `html/template` `text/template(+parse)` `text/scanner` `text/tabwriter` | DOMParser 不被要求；模板没有任何标准 | 生态包 |
| **数据与持久化** | `database/sql(+driver)` | IndexedDB 也不在最小集 | `node:sqlite`、`Bun:sqlite`、生态 ORM |
| **容器与算法** | `container/{heap,list,ring}` `index/suffixarray` `math/bits` `math/cmplx` | 通用算法容器不是平台 API | 生态包 / 手写 |
| **测试** | `testing` `testing/{fstest,iotest,quick,slogtest,synctest}` | 测试框架从来不是平台 API | `node:test`、`bun:test`、`Deno.test` |

---

## 4. 🟡 部分覆盖的清单（45 项）—— 这一类更值得看

这些不是"没有"，是"有，但窄"。差异集中在五种模式：

1. **一次性 vs 流式**
   `crypto/subtle` 有 SHA/AES/HMAC 全套，但 `subtle.digest()` 必须一次给完整个 buffer——**没有 `hash.Hash` 那样的增量更新接口**；AEAD 同理（没有增量加密的公共 API）。
2. **只有客户端 vs 也要服务端**
   `net/http` 只对应上 `fetch/Request/Response/Headers`；`http.ListenAndServe` 那半边在最小集里不存在。
3. **异步流 vs 同步 IO**
   Web Streams 有 `ReadableStream/WritableStream/TransformStream`，但全是异步拉取模型；`bufio`/`io` 的同步 `Reader`/`Writer`、`Scanner`（按行切分）都没有。
4. **单算法/单格式 vs 全枚举**
   Compression Standard 只有 `gzip`/`deflate`/`deflate-raw`；WebCrypto 不收 MD5/DES/RC4/DSA；base64 有（`atob`/`btoa`）但 base32/hex 没有，且 `atob` 是 latin1 字符串语义、无流式 API。
5. **只有输出通道 vs 分级与结构化**
   `console` 对应上 `log`/`log/slog` 的输出面，但**没有级别、没有结构化字段、没有多 sink**。

几处需要特别点出的：

- `context` → 只有 `AbortController/AbortSignal`（取消能组合、能超时），**没有 value 传播与 deadline 树**。TC55 正在补这块：仓库里的 **AsyncLocalStorage 草案**（`raw/wintertc-asynclocalstorage.md`）就是它的可移植子集。
- `time` → `Date`（ECMA-262）+ `performance.now` + `setTimeout/setInterval` 覆盖计时与调度，但**时区/格式化**要靠 `Intl`（ECMA-402），而最小集清单里连 Intl 都没列。
- `sync/atomic` → `Atomics` 属 ECMA-262，但它只在 `SharedArrayBuffer` 上成立，而 §5.3 不要求 Workers，实际可用面完全取决于运行时。
- `encoding/base64` → `atob`/`btoa` 只处理 latin1 字符串，`base64url`、`RawStdEncoding`、流式编码器都没有。

---

## 5. 反向：WinterTC（Web 平台）有、Go 没有的

这是同一张表的另一半，很多是 Go 里**根本没有语言级概念**的东西：

| Web / WinterTC | 说明 | Go 侧的实情 |
| --- | --- | --- |
| Web Streams（含 BYOB、backpressure、`TransformStream`） | 可组合的异步流抽象 | Go 只有同步 `io.Reader/Writer`；异步流靠 channel + goroutine 手搓 |
| WebAssembly JS API | 完整 Wasm 宿主接口（Module/Instance/Memory/Table/Tag/Exception） | Go 编译**到** Wasm，但没有 Wasm 宿主 API |
| DOM/Event 体系 | `EventTarget`/`Event`/`CustomEvent`/`MessageChannel`/`MessagePort` | 无事件模型；最接近的是 `chan` + `context` |
| `subtle` 的 `CryptoKey` | 不可导出的密钥句柄（密钥留在宿主里） | `crypto/*` 的密钥是普通结构体，永远可读取 |
| `AbortSignal` | 可组合、可超时、可传染的取消原语 | `context.Context` 是等价物（Go 这方面反而更强） |
| `structuredClone` | 通用结构化克隆（含循环引用、Transferable） | 无；`encoding/gob` 语义不同 |
| `URLPattern` | 用模板语法匹配 URL 的路径/查询/主机 | 只有 `net/http` 的 `ServeMux` 模式（且不是通用 API） |
| `FormData` / `Blob` / `File` | 表单与二进制对象的统一点 | 无对应对象模型 |
| `Console` 格式化规范 | 跨运行时可预期的 `%s/%d/%o` 格式化 | `fmt` 更强，但两者语义不同 |

---

## 6. 如果你是要建一个运行时，这份对照的实际结论

- **想吃 WinterTC 的互操作红利**，只有第 2 节那 11 个"完全覆盖" + 45 个"部分"里的那部分能力是**免费**的：照 ECMA-429 实现就能跨运行时。
- **剩下 117 项必须自己做决策**：
  - 跟随事实标准（`node:fs` / `node:net` / `node:crypto` 的形状）→ Node 兼容层，最容易吃到现成的 npm 生态；
  - 自己设计（`Deno.serve` / `Bun.file` 那种）→ API 更干净，但没有生态兜底；
  - 两者都给（Node 兼容层 + 原生风格 API）→ 最贵，但 Deno/Bun 都在这么做。
- **哪一档最不能省**：文件系统、网络服务端、子进程、TLS/证书、流式加密 —— 这五类任何"能跑服务"的运行时都绕不过，而 WinterTC 一条都没规定。
- **可以拖到最后**：图像编解码、归档、CSV/XML、模板、测试框架（前四类有成熟 npm 包，测试框架可以只做薄封装）。

---

## 7. 复现

```bash
# Go 侧：173 个包
go list std | grep -vE '(^|/)internal(/|$)|^vendor/|^cmd/'

# WinterTC 侧：规范源
curl -s https://raw.githubusercontent.com/wintercg/proposal-common-minimum-api/main/index.bs \
  -o raw/ecma-429-index.bs

# 重新生成对照表
python3 scripts/build_report.py   # → go-stdlib-vs-wintertc.csv / gaps-only.csv
python3 scripts/build_lists.py    # → list-go-stdlib.md / missing-in-wintertc.md
```

映射表是**人工逐包判定**的（`scripts/build_report.py` 里的 `EXPLICIT` / `RULES`，脚本会在有包没被映射时直接报错退出，所以 173 个包一个不漏）。判定里带主观成分的地方是"多窄算部分"——我的尺度写在文件头的口径一节里。
