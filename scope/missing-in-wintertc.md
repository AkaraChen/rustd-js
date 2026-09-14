# WinterTC（ECMA-429 最小公共 API）缺失清单

口径：**Go 标准库能做的事，WinterTC 最小公共 API 里没有对应条目**。
逐包判定见 `go-stdlib-vs-wintertc.csv`，本文件只把「缺」和「部分」抽出来。

- ❌ 缺失 = 最小集里**完全没有**任何对应 API
- 🟡 部分 = 有对应条目，但能力明显更窄（一次性 vs 流式、只客户端 vs 也服务端、只有单算法 vs 全算法）

> ⚠️ 读之前先记住一件事：这**不是**"WinterTC 做得差"。ECMA-429 只规定"浏览器和服务端运行时**共有**的那层最小互操作面"，
> 语言层能力由 ECMA-262 兜底（§2 强制），文件系统/网络/进程这类**平台差异大**的能力被**故意留给运行时自己扩展**。
> 所以「缺失」更准确的读法是：**这些能力不会通过 WinterTC 获得互操作性，只能指望运行时私有 API。**


## 基础与语言层

### ❌ 完全缺失（5）

| Go 包 | 说明 |
| --- | --- |
| `math/bits` | 位操作库（前导零/位反转/乘法高位）没有标准 API；语言位运算符只有 32 位语义 |
| `math/cmplx` | 无复数支持 |
| `regexp/syntax` | 没有正则语法树/编译结果检视 API |
| `structs` | structs.HostLayout 是 cgo 互操作概念，无对应 |
| `unsafe` | JS 没有裸内存/指针概念 |

### 🟡 部分覆盖（17）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `bytes` | Uint8Array / DataView (ECMA-262) | 字节序列操作属语言层；但没有 bytes.Buffer 那样的同步可增长缓冲区与 bytes.Reader |
| `cmp` | ECMA-262 的比较语义（<、==） | 三值比较器/泛型比较函数没有标准形式 |
| `context` | AbortController / AbortSignal (§5.1) | 取消有（AbortSignal 还能组合与超时）；但没有 value 传播/deadline 树的等价物。TC55 正在补这一块：AsyncLocalStorage 草案（见 raw/wintertc-asynclocalstorage.md） |
| `fmt` | console (Console Standard, §5.2) | 只有 console 的格式化；没有 Sprintf 动词库、没有 io.Writer 抽象 |
| `iter` | 迭代协议 (ECMA-262) | 迭代协议在语言层，但没有 Seq 式惰性管线与显式 yield 类型 |
| `maps` | Map / Set (ECMA-262) | 容器在语言层，缺 Keys/Values/Equal/Clone 这类集合工具 |
| `math/rand` | crypto.getRandomValues() (§5.2) | 安全随机有；没有可播种 PRNG、没有分布采样 API |
| `math/rand/v2` | crypto.getRandomValues() (§5.2) | 同上 |
| `reflect` | Proxy / Reflect (ECMA-262) | 对象属性反射在语言层；Go 的 reflect 是静态类型元编程，两者语义不同 |
| `slices` | Array.prototype / TypedArray.prototype (ECMA-262) | 常用操作在语言层，缺泛型二分、稳定排序、Chunk/Clip 等工具 |
| `sort` | Array.prototype.sort (ECMA-262) | 排序在语言层，但没有三值比较器接口、没有 PartialSort/稳定性的显式契约 |
| `strconv` | Number.parseInt/parseFloat/toString (ECMA-262) | 缺进制/精度控制，也没有 strconv.Quote 那类转义工具 |
| `strings` | String 原语 (ECMA-262) | 缺 Sprintf 式格式化、Strings.Builder 式的增量拼接、[]byte↔string 零拷贝转换 |
| `unicode` | RegExp \p{...} 属性类 (ECMA-262) | 有属性匹配，但没有 Unicode 分类表 API；大小写映射靠 String.prototype.toUpperCase，locale 相关要 Intl |
| `unicode/utf16` | String 本身即 UTF-16 (ECMA-262) | 有 codePointAt/fromCodePoint，没有显式 UTF-16 编解码器 |
| `unicode/utf8` | TextEncoder / TextDecoder (Encoding Standard, §5.1) | 编解码覆盖，但没有逐码点的校验/遍历 API（RuneCount/Valid/DecodeRune） |
| `unique` | - | 值驻留（interning）没有标准 API；语言层只有字符串/原始值隐式驻留，弱引用走 WeakRef |


## 字节与流

### ❌ 完全缺失（2）

| Go 包 | 说明 |
| --- | --- |
| `io/fs` | 最小集不含文件系统 API（File System Standard / OPFS 未列入 ECMA-429） |
| `io/ioutil` | 已废弃包；对应能力（一次性读整个流）在最小集里没有便捷 API |

### 🟡 部分覆盖（2）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `bufio` | Web Streams（ReadableStream/WritableStream + reader）(§5.1) | 只有异步流抽象；没有同步 BufferedReader/Writer，也没有按行/按词切分的 Scanner |
| `io` | ReadableStream / WritableStream / TransformStream (§5.1) | Web Streams 是异步拉取/管道模型；没有同步 Reader/Writer 接口，也没有 io.Copy 的同步形式 |


## 编码与序列化

### ❌ 完全缺失（9）

| Go 包 | 说明 |
| --- | --- |
| `encoding/ascii85` | 无 |
| `encoding/asn1` | 无 ASN.1/DER API（WebCrypto 的 importKey 只是入口，不暴露解析） |
| `encoding/base32` | 无 |
| `encoding/csv` | 无 CSV API |
| `encoding/gob` | 无 |
| `encoding/hex` | 无 |
| `encoding/pem` | 无 PEM 编解码 API |
| `encoding/xml` | DOMParser/XMLSerializer 不在最小集；XML 没有任何被要求的 API |
| `mime/quotedprintable` | 无 |

### 🟡 部分覆盖（5）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `encoding` | TextEncoder / TextDecoder (Encoding Standard) | 只有文本编解码接口；没有通用 Marshal/Unmarshal 框架 |
| `encoding/base64` | atob() / btoa() (§5.2) | 只有 base64，且是 latin1 字符串语义；无 base64url、无流式编码器、无 RawStdEncoding 变体 |
| `encoding/binary` | DataView / TypedArray (ECMA-262) | 语言层能读写二进制，但没有结构体/格式驱动的编解码器，字节序要自己写 |
| `mime` | Blob.type / FormData (§5.1) | MIME 类型只是 Blob 上的字符串；没有 MIME 解析/构造 API（MIME Sniffing 规范没有 API 面） |
| `mime/multipart` | FormData (§5.1) | FormData 能产出 multipart，但不能把 multipart 请求体解析回来（服务端方向缺口） |


## 压缩与归档

### ❌ 完全缺失（4）

| Go 包 | 说明 |
| --- | --- |
| `archive/tar` | 无 |
| `archive/zip` | 无 |
| `compress/bzip2` | Compression Standard 不含 bzip2 |
| `compress/lzw` | Compression Standard 不含 LZW |


## 加解密

### ❌ 完全缺失（15）

| Go 包 | 说明 |
| --- | --- |
| `crypto/des` | WebCrypto 不含 DES/3DES |
| `crypto/dsa` | WebCrypto 不含 DSA |
| `crypto/fips140` | WebCrypto 不含该算法/能力 |
| `crypto/mlkem` | WebCrypto 不含该算法/能力 |
| `crypto/pbkdf2` | WebCrypto 不含该算法/能力 |
| `crypto/rc4` | WebCrypto 不含 RC4 |
| `crypto/tls` | 最小集只给 fetch，不暴露 TLS 配置面（证书固定/SNI/ALPN/会话复用都没有） |
| `crypto/x509` | 没有任何证书解析/校验 API（浏览器内部有，未标准化到运行时） |
| `crypto/x509/pkix` | 无 |
| `hash` | 没有通用哈希接口（语言层也没有） |
| `hash/adler32` | 无非密码学校验和 |
| `hash/crc32` | 无 |
| `hash/crc64` | 无 |
| `hash/fnv` | 无 |
| `hash/maphash` | 无（哈希种子/DoS 防护不暴露给应用） |

### 🟡 部分覆盖（16）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `crypto` | crypto / crypto.getRandomValues() (§5.2) | 命名空间与安全随机有；没有等价的算法包体系 |
| `crypto/aes` | SubtleCrypto: AES-CBC / AES-CTR / AES-GCM / AES-KW | 块密码本身没有单独接口，只能用封装好的模式，且必须整块处理 |
| `crypto/cipher` | SubtleCrypto（AEAD 仅 AES-GCM） | 没有可组合的块/流密码接口让使用者自己搭模式（CTR+HMAC 之类要拿非标准扩展） |
| `crypto/ecdh` | SubtleCrypto: ECDH / X25519 | 覆盖；但派生密钥不可导出、无裸点运算 |
| `crypto/ecdsa` | SubtleCrypto: ECDSA | 覆盖签名/验签，一次性 |
| `crypto/ed25519` | SubtleCrypto: Ed25519 | 覆盖，一次性 |
| `crypto/elliptic` | SubtleCrypto（曲线由算法与 namedCurve 隐含） | 没有裸椭圆曲线运算 API |
| `crypto/hkdf` | SubtleCrypto: HKDF | 覆盖派生，一次性 |
| `crypto/hmac` | SubtleCrypto: HMAC | 只有一次性 sign/verify，没有流式 MAC |
| `crypto/md5` | WebCrypto 不含 MD5 | MD5 不在 WebCrypto；只能靠运行时扩展（Node 的 createHash） |
| `crypto/rsa` | SubtleCrypto: RSA-OAEP / RSASSA-PKCS1-v1_5 / RSA-PSS | 覆盖三种模式，一次性 |
| `crypto/sha1` | SubtleCrypto: SHA-1 | 只有一次性 digest |
| `crypto/sha256` | SubtleCrypto: SHA-256 | 只有一次性 digest，无流式更新 |
| `crypto/sha3` | SubtleCrypto: SHA-3（Level 2 草案新增，实现可选） | 规范里有但可选；同样无流式形式 |
| `crypto/sha512` | SubtleCrypto: SHA-384 / SHA-512 | 只有一次性 digest |
| `crypto/subtle` | crypto.subtle / SubtleCrypto (§5.1) | 有 SHA-1/256/384/512（SHA-3 见草案）、AES-CBC/CTR/GCM/KW、RSA 系、ECDSA/ECDH/Ed25519/X25519、HMAC、HKDF/PBKDF2；但**全是一次性整块 API**：无流式哈希、无增量 AEAD、密钥句柄不可导出 |


## 网络

### ❌ 完全缺失（13）

| Go 包 | 说明 |
| --- | --- |
| `net` | 无 TCP/UDP/Unix socket、无 DNS、无网络接口枚举 |
| `net/http/cgi` | 无 |
| `net/http/cookiejar` | cookie 存储与策略不是平台 API（浏览器内部实现，服务端运行时需自备） |
| `net/http/fcgi` | 无 |
| `net/http/httptest` | 无测试用 HTTP 服务器 API |
| `net/http/httptrace` | fetch 不暴露连接级可观测性（DNS/连接/首字节细分计时） |
| `net/http/httputil` | 无反向代理/请求转储工具（要自己基于 fetch 拼） |
| `net/mail` | 无邮件地址/消息解析 |
| `net/netip` | 没有 IP 地址/前缀类型（URL 里的 host 只是字符串） |
| `net/rpc` | 无 RPC |
| `net/rpc/jsonrpc` | 无 RPC |
| `net/smtp` | 无 SMTP 客户端 |
| `net/textproto` | 无文本协议读写工具（Header 的键值对在 fetch 里有，但仅限 HTTP） |

### 🟡 部分覆盖（1）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `net/http` | fetch() / Request / Response / Headers (§5.1–5.2) | 只覆盖**客户端** HTTP；服务端（listen/route/handler/middleware）不在最小集 |


## 文件系统与路径

### ❌ 完全缺失（4）

| Go 包 | 说明 |
| --- | --- |
| `embed` | 资源内联不是平台 API（Import Attributes 属 ECMAScript 提案，且只解决模块导入） |
| `path` | 只有 URL 路径概念，没有文件路径 API |
| `path/filepath` | 无（File System Standard / OPFS 未列入 ECMA-429） |
| `plugin` | 无动态库/插件 ABI |


## 进程与系统

### ❌ 完全缺失（6）

| Go 包 | 说明 |
| --- | --- |
| `flag` | 无 CLI 参数解析 |
| `os` | 无 env/argv/文件描述符/进程 API；最小集刻意不含，由运行时扩展承担 |
| `os/exec` | 无子进程 API |
| `os/signal` | 无信号 API |
| `os/user` | 无用户/组信息 |
| `syscall` | 无系统调用面 |


## 并发与运行时

### ❌ 完全缺失（9）

| Go 包 | 说明 |
| --- | --- |
| `runtime` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/cgo` | 无 FFI 概念 |
| `runtime/coverage` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/debug` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/metrics` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/pprof` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/race` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `runtime/trace` | 运行时自省（GC/调度器/pprof/trace/metrics/竞态检测）不是平台 API |
| `sync` | 无互斥锁/条件变量/WaitGroup 等价物（Atomics 属 ECMA-262，但最小集不要求 Web Workers，§5.3） |

### 🟡 部分覆盖（1）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `sync/atomic` | Atomics (ECMA-262) | 语言层有原子操作，但只对 SharedArrayBuffer 有意义，而最小集不要求 workers，实际可用面取决于运行时 |


## 时间与本地化

### ❌ 完全缺失（1）

| Go 包 | 说明 |
| --- | --- |
| `time/tzdata` | 无（时区数据在 Intl/ECMA-402 内，最小集不要求） |

### 🟡 部分覆盖（1）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `time` | Date (ECMA-262) + performance.now() / setTimeout() / setInterval() (§5.2) | 计时与调度有；但缺时区/日历格式化 API（Intl/ECMA-402 有，但不在最小集清单里），也没有比 elapsed 更细的时钟语义 |


## 文本与模板

### ❌ 完全缺失（6）

| Go 包 | 说明 |
| --- | --- |
| `html` | HTML 解析器不在最小集（DOMParser 不被要求） |
| `html/template` | 无模板引擎 |
| `text/scanner` | 无词法扫描 API |
| `text/tabwriter` | 无表格排版 API |
| `text/template` | 无模板引擎 |
| `text/template/parse` | 无模板引擎 |


## 图像

### ❌ 完全缺失（7）

| Go 包 | 说明 |
| --- | --- |
| `image` | 图像模型（RGBA/YCbCr 等）不在最小集 |
| `image/color` | 无颜色类型 API |
| `image/color/palette` | 无调色板 |
| `image/draw` | 无合成/绘制 API（Canvas 不在最小集） |
| `image/gif` | 无 GIF 编解码 |
| `image/jpeg` | 无 JPEG 编解码 |
| `image/png` | 无 PNG 编解码 |


## 数据与持久化

### ❌ 完全缺失（2）

| Go 包 | 说明 |
| --- | --- |
| `database/sql` | 无数据库抽象层 |
| `database/sql/driver` | 无驱动接口 |


## 容器与算法

### ❌ 完全缺失（4）

| Go 包 | 说明 |
| --- | --- |
| `container/heap` | 无优先队列 |
| `container/list` | 无双向链表（语言层没有；只能自己用 Map 模拟） |
| `container/ring` | 无环形缓冲 |
| `index/suffixarray` | 无后缀数组/子串索引 |


## 工具链与元编程

### ❌ 完全缺失（14）

| Go 包 | 说明 |
| --- | --- |
| `go/ast` | 无 AST API |
| `go/build` | 无构建系统 API |
| `go/build/constraint` | 无构建约束表达式 API |
| `go/constant` | 无编译期常量值 API |
| `go/doc` | 无文档抽取 API |
| `go/doc/comment` | 无文档注释解析 API |
| `go/format` | 无代码格式化 API（prettier/oxfmt 都是生态工具，不是平台 API） |
| `go/importer` | 无包导入/类型信息装载 API |
| `go/parser` | 无解析器 API（JS 侧对应物是 babel/TS，属生态） |
| `go/printer` | 无源码打印 API |
| `go/scanner` | 无词法分析 API |
| `go/token` | 无位置/词法单元 API |
| `go/types` | 无类型检查 API |
| `go/version` | 无版本比较 API |


## 诊断与可观测

### ❌ 完全缺失（10）

| Go 包 | 说明 |
| --- | --- |
| `debug/buildinfo` | 二进制/调试格式解析（DWARF/ELF/Mach-O/PE/Plan9/gosym）不属于 Web 平台 |
| `debug/dwarf` | 无 |
| `debug/elf` | 无 |
| `debug/gosym` | 无 |
| `debug/macho` | 无 |
| `debug/pe` | 无 |
| `debug/plan9obj` | 无 |
| `expvar` | 无运行时变量导出端点 |
| `log/syslog` | 无 |
| `net/http/pprof` | 无内置性能剖析端点 |

### 🟡 部分覆盖（2）

| Go 包 | WinterTC 对应 | 差在哪 |
| --- | --- | --- |
| `log` | console (Console Standard, §5.2) | 只有输出通道；无级别、无结构化、无多目标 sink（运行时各自给 node:util/Deno 的 log 不在最小集） |
| `log/slog` | console (Console Standard, §5.2) | 同上；结构化日志没有任何平台约定 |


## 测试

### ❌ 完全缺失（6）

| Go 包 | 说明 |
| --- | --- |
| `testing` | 无标准测试框架 |
| `testing/fstest` | 无 |
| `testing/iotest` | 无 |
| `testing/quick` | 无属性测试/随机测试 API |
| `testing/slogtest` | 无 |
| `testing/synctest` | 无 |
