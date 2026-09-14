# Go 标准库包清单（go1.25.6 darwin/arm64）

来源：`go list std`，去掉 `internal/**`、`vendor/**`、`cmd/**` 后剩 **%d** 个包（含子包）。完整原始输出见 `raw/go-std-packages.txt`。分类是我按能力域划的，不是 Go 官方分类。

## 基础与语言层（27）

- `bytes` — Package bytes implements functions for the manipulation of byte slices.
- `cmp` — Package cmp provides types and functions related to comparing ordered values.
- `context` — Package context defines the Context type, which carries deadlines, cancellation signals, and other request-scoped values across API boundaries and between processes.
- `errors` — Package errors implements functions to manipulate errors.
- `fmt` — Package fmt implements formatted I/O with functions analogous to C's printf and scanf.
- `iter` — Package iter provides basic definitions and operations related to iterators over sequences.
- `maps` — Package maps defines various functions useful with maps of any type.
- `math` — Package math provides basic constants and mathematical functions.
- `math/big` — Package big implements arbitrary-precision arithmetic (big numbers).
- `math/bits` — Package bits implements bit counting and manipulation functions for the predeclared unsigned integer types.
- `math/cmplx` — Package cmplx provides basic constants and mathematical functions for complex numbers.
- `math/rand` — Package rand implements pseudo-random number generators suitable for tasks such as simulation, but it should not be used for security-sensitive work.
- `math/rand/v2` — Package rand implements pseudo-random number generators suitable for tasks such as simulation, but it should not be used for security-sensitive work.
- `reflect` — Package reflect implements run-time reflection, allowing a program to manipulate objects with arbitrary types.
- `regexp` — Package regexp implements regular expression search.
- `regexp/syntax` — Package syntax parses regular expressions into parse trees and compiles parse trees into programs.
- `slices` — Package slices defines various functions useful with slices of any type.
- `sort` — Package sort provides primitives for sorting slices and user-defined collections.
- `strconv` — Package strconv implements conversions to and from string representations of basic data types.
- `strings` — Package strings implements simple functions to manipulate UTF-8 encoded strings.
- `structs` — Package structs defines marker types that can be used as struct fields to modify the properties of a struct.
- `unicode` — Package unicode provides data and functions to test some properties of Unicode code points.
- `unicode/utf16` — Package utf16 implements encoding and decoding of UTF-16 sequences.
- `unicode/utf8` — Package utf8 implements functions and constants to support text encoded in UTF-8.
- `unique` — The unique package provides facilities for canonicalizing ("interning") comparable values.
- `unsafe` — Package unsafe contains operations that step around the type safety of Go programs.
- `weak` — Package weak provides ways to safely reference memory weakly, that is, without preventing its reclamation.

## 字节与流（4）

- `bufio` — Package bufio implements buffered I/O. It wraps an io.Reader or io.Writer object, creating another object (Reader or Writer) that also implements the interface but provides buffering and some help for textual I/O.
- `io` — Package io provides basic interfaces to I/O primitives.
- `io/fs` — Package fs defines basic interfaces to a file system.
- `io/ioutil` — Package ioutil implements some I/O utility functions.

## 编码与序列化（15）

- `encoding` — Package encoding defines interfaces shared by other packages that convert data to and from byte-level and textual representations.
- `encoding/ascii85` — Package ascii85 implements the ascii85 data encoding as used in the btoa tool and Adobe's PostScript and PDF document formats.
- `encoding/asn1` — Package asn1 implements parsing of DER-encoded ASN.1 data structures, as defined in ITU-T Rec X.690.
- `encoding/base32` — Package base32 implements base32 encoding as specified by RFC 4648.
- `encoding/base64` — Package base64 implements base64 encoding as specified by RFC 4648.
- `encoding/binary` — Package binary implements simple translation between numbers and byte sequences and encoding and decoding of varints.
- `encoding/csv` — Package csv reads and writes comma-separated values (CSV) files.
- `encoding/gob` — Package gob manages streams of gobs - binary values exchanged between an [Encoder] (transmitter) and a [Decoder] (receiver).
- `encoding/hex` — Package hex implements hexadecimal encoding and decoding.
- `encoding/json` — Package json implements encoding and decoding of JSON as defined in RFC 7159.
- `encoding/pem` — Package pem implements the PEM data encoding, which originated in Privacy Enhanced Mail.
- `encoding/xml` — Package xml implements a simple XML 1.0 parser that understands XML name spaces.
- `mime` — Package mime implements parts of the MIME spec.
- `mime/multipart` — Package multipart implements MIME multipart parsing, as defined in RFC 2046.
- `mime/quotedprintable` — Package quotedprintable implements quoted-printable encoding as specified by RFC 2045.

## 压缩与归档（7）

- `archive/tar` — Package tar implements access to tar archives.
- `archive/zip` — Package zip provides support for reading and writing ZIP archives.
- `compress/bzip2` — Package bzip2 implements bzip2 decompression.
- `compress/flate` — Package flate implements the DEFLATE compressed data format, described in RFC 1951.
- `compress/gzip` — Package gzip implements reading and writing of gzip format compressed files, as specified in RFC 1952.
- `compress/lzw` — Package lzw implements the Lempel-Ziv-Welch compressed data format, described in T. A. Welch, “A Technique for High-Performance Data Compression”, Computer, 17(6) (June 1984), pp 8-19.
- `compress/zlib` — Package zlib implements reading and writing of zlib format compressed data, as specified in RFC 1950.

## 加解密（32）

- `crypto` — Package crypto collects common cryptographic constants.
- `crypto/aes` — Package aes implements AES encryption (formerly Rijndael), as defined in U.S. Federal Information Processing Standards Publication 197.
- `crypto/cipher` — Package cipher implements standard block cipher modes that can be wrapped around low-level block cipher implementations.
- `crypto/des` — Package des implements the Data Encryption Standard (DES) and the Triple Data Encryption Algorithm (TDEA) as defined in U.S. Federal Information Processing Standards Publication 46-3.
- `crypto/dsa` — Package dsa implements the Digital Signature Algorithm, as defined in FIPS 186-3.
- `crypto/ecdh` — Package ecdh implements Elliptic Curve Diffie-Hellman over NIST curves and Curve25519.
- `crypto/ecdsa` — Package ecdsa implements the Elliptic Curve Digital Signature Algorithm, as defined in [FIPS 186-5].
- `crypto/ed25519` — Package ed25519 implements the Ed25519 signature algorithm.
- `crypto/elliptic` — Package elliptic implements the standard NIST P-224, P-256, P-384, and P-521 elliptic curves over prime fields.
- `crypto/fips140` — (无简介)
- `crypto/hkdf` — Package hkdf implements the HMAC-based Extract-and-Expand Key Derivation Function (HKDF) as defined in RFC 5869.
- `crypto/hmac` — Package hmac implements the Keyed-Hash Message Authentication Code (HMAC) as defined in U.S. Federal Information Processing Standards Publication 198.
- `crypto/md5` — Package md5 implements the MD5 hash algorithm as defined in RFC 1321.
- `crypto/mlkem` — Package mlkem implements the quantum-resistant key encapsulation method ML-KEM (formerly known as Kyber), as specified in [NIST FIPS 203].
- `crypto/pbkdf2` — Package pbkdf2 implements the key derivation function PBKDF2 as defined in RFC 8018 (PKCS #5 v2.1).
- `crypto/rand` — Package rand implements a cryptographically secure random number generator.
- `crypto/rc4` — Package rc4 implements RC4 encryption, as defined in Bruce Schneier's Applied Cryptography.
- `crypto/rsa` — Package rsa implements RSA encryption as specified in PKCS #1 and RFC 8017.
- `crypto/sha1` — Package sha1 implements the SHA-1 hash algorithm as defined in RFC 3174.
- `crypto/sha256` — Package sha256 implements the SHA224 and SHA256 hash algorithms as defined in FIPS 180-4.
- `crypto/sha3` — Package sha3 implements the SHA-3 hash algorithms and the SHAKE extendable output functions defined in FIPS 202.
- `crypto/sha512` — Package sha512 implements the SHA-384, SHA-512, SHA-512/224, and SHA-512/256 hash algorithms as defined in FIPS 180-4.
- `crypto/subtle` — Package subtle implements functions that are often useful in cryptographic code but require careful thought to use correctly.
- `crypto/tls` — Package tls partially implements TLS 1.2, as specified in RFC 5246, and TLS 1.3, as specified in RFC 8446.
- `crypto/x509` — Package x509 implements a subset of the X.509 standard.
- `crypto/x509/pkix` — Package pkix contains shared, low level structures used for ASN.1 parsing and serialization of X.509 certificates, CRL and OCSP.
- `hash` — Package hash provides interfaces for hash functions.
- `hash/adler32` — Package adler32 implements the Adler-32 checksum.
- `hash/crc32` — Package crc32 implements the 32-bit cyclic redundancy check, or CRC-32, checksum.
- `hash/crc64` — Package crc64 implements the 64-bit cyclic redundancy check, or CRC-64, checksum.
- `hash/fnv` — Package fnv implements FNV-1 and FNV-1a, non-cryptographic hash functions created by Glenn Fowler, Landon Curt Noll, and Phong Vo.
- `hash/maphash` — Package maphash provides hash functions on byte sequences and comparable values.

## 网络（15）

- `net` — Package net provides a portable interface for network I/O, including TCP/IP, UDP, domain name resolution, and Unix domain sockets.
- `net/http` — Package http provides HTTP client and server implementations.
- `net/http/cgi` — Package cgi implements CGI (Common Gateway Interface) as specified in RFC 3875.
- `net/http/cookiejar` — Package cookiejar implements an in-memory RFC 6265-compliant http.CookieJar.
- `net/http/fcgi` — Package fcgi implements the FastCGI protocol.
- `net/http/httptest` — Package httptest provides utilities for HTTP testing.
- `net/http/httptrace` — Package httptrace provides mechanisms to trace the events within HTTP client requests.
- `net/http/httputil` — Package httputil provides HTTP utility functions, complementing the more common ones in the net/http package.
- `net/mail` — Package mail implements parsing of mail messages.
- `net/netip` — Package netip defines an IP address type that's a small value type.
- `net/rpc` — Package rpc provides access to the exported methods of an object across a network or other I/O connection.
- `net/rpc/jsonrpc` — Package jsonrpc implements a JSON-RPC 1.0 ClientCodec and ServerCodec for the rpc package.
- `net/smtp` — Package smtp implements the Simple Mail Transfer Protocol as defined in RFC 5321.
- `net/textproto` — Package textproto implements generic support for text-based request/response protocols in the style of HTTP, NNTP, and SMTP.
- `net/url` — Package url parses URLs and implements query escaping.

## 文件系统与路径（4）

- `embed` — Package embed provides access to files embedded in the running Go program.
- `path` — Package path implements utility routines for manipulating slash-separated paths.
- `path/filepath` — Package filepath implements utility routines for manipulating filename paths in a way compatible with the target operating system-defined file paths.
- `plugin` — Package plugin implements loading and symbol resolution of Go plugins.

## 进程与系统（6）

- `flag` — Package flag implements command-line flag parsing.
- `os` — Package os provides a platform-independent interface to operating system functionality.
- `os/exec` — Package exec runs external commands.
- `os/signal` — Package signal implements access to incoming signals.
- `os/user` — Package user allows user account lookups by name or id.
- `syscall` — Package syscall contains an interface to the low-level operating system primitives.

## 并发与运行时（10）

- `runtime` — Package runtime contains operations that interact with Go's runtime system, such as functions to control goroutines.
- `runtime/cgo` — Package cgo contains runtime support for code generated by the cgo tool.
- `runtime/coverage` — Package coverage contains APIs for writing coverage profile data at runtime from long-running and/or server programs that do not terminate via os.Exit.
- `runtime/debug` — Package debug contains facilities for programs to debug themselves while they are running.
- `runtime/metrics` — Package metrics provides a stable interface to access implementation-defined metrics exported by the Go runtime.
- `runtime/pprof` — Package pprof writes runtime profiling data in the format expected by the pprof visualization tool.
- `runtime/race` — Package race implements data race detection logic.
- `runtime/trace` — Package trace contains facilities for programs to generate traces for the Go execution tracer.
- `sync` — Package sync provides basic synchronization primitives such as mutual exclusion locks.
- `sync/atomic` — Package atomic provides low-level atomic memory primitives useful for implementing synchronization algorithms.

## 时间与本地化（2）

- `time` — Package time provides functionality for measuring and displaying time.
- `time/tzdata` — Package tzdata provides an embedded copy of the timezone database.

## 文本与模板（6）

- `html` — Package html provides functions for escaping and unescaping HTML text.
- `html/template` — Package template (html/template) implements data-driven templates for generating HTML output safe against code injection.
- `text/scanner` — Package scanner provides a scanner and tokenizer for UTF-8-encoded text.
- `text/tabwriter` — Package tabwriter implements a write filter (tabwriter.Writer) that translates tabbed columns in input into properly aligned text.
- `text/template` — Package template implements data-driven templates for generating textual output.
- `text/template/parse` — Package parse builds parse trees for templates as defined by text/template and html/template.

## 图像（7）

- `image` — Package image implements a basic 2-D image library.
- `image/color` — Package color implements a basic color library.
- `image/color/palette` — Package palette provides standard color palettes.
- `image/draw` — Package draw provides image composition functions.
- `image/gif` — Package gif implements a GIF image decoder and encoder.
- `image/jpeg` — Package jpeg implements a JPEG image decoder and encoder.
- `image/png` — Package png implements a PNG image decoder and encoder.

## 数据与持久化（2）

- `database/sql` — Package sql provides a generic interface around SQL (or SQL-like) databases.
- `database/sql/driver` — Package driver defines interfaces to be implemented by database drivers as used by package sql.

## 容器与算法（4）

- `container/heap` — Package heap provides heap operations for any type that implements heap.Interface.
- `container/list` — Package list implements a doubly linked list.
- `container/ring` — Package ring implements operations on circular lists.
- `index/suffixarray` — Package suffixarray implements substring search in logarithmic time using an in-memory suffix array.

## 工具链与元编程（14）

- `go/ast` — Package ast declares the types used to represent syntax trees for Go packages.
- `go/build` — Package build gathers information about Go packages.
- `go/build/constraint` — Package constraint implements parsing and evaluation of build constraint lines.
- `go/constant` — Package constant implements Values representing untyped Go constants and their corresponding operations.
- `go/doc` — Package doc extracts source code documentation from a Go AST.
- `go/doc/comment` — Package comment implements parsing and reformatting of Go doc comments, (documentation comments), which are comments that immediately precede a top-level declaration of a package, const, func, type, or var.
- `go/format` — Package format implements standard formatting of Go source.
- `go/importer` — Package importer provides access to export data importers.
- `go/parser` — Package parser implements a parser for Go source files.
- `go/printer` — Package printer implements printing of AST nodes.
- `go/scanner` — Package scanner implements a scanner for Go source text.
- `go/token` — Package token defines constants representing the lexical tokens of the Go programming language and basic operations on tokens (printing, predicates).
- `go/types` — Package types declares the data types and implements the algorithms for type-checking of Go packages.
- `go/version` — Package version provides operations on [Go versions] in [Go toolchain name syntax]: strings like "go1.20", "go1.21.0", "go1.22rc2", and "go1.23.4-bigcorp".

## 诊断与可观测（12）

- `debug/buildinfo` — Package buildinfo provides access to information embedded in a Go binary about how it was built.
- `debug/dwarf` — Package dwarf provides access to DWARF debugging information loaded from executable files, as defined in the DWARF 2.0 Standard at http://dwarfstd.org/doc/dwarf-2.0.0.pdf.
- `debug/elf` — Package elf implements access to ELF object files.
- `debug/gosym` — Package gosym implements access to the Go symbol and line number tables embedded in Go binaries generated by the gc compilers.
- `debug/macho` — Package macho implements access to Mach-O object files.
- `debug/pe` — Package pe implements access to PE (Microsoft Windows Portable Executable) files.
- `debug/plan9obj` — Package plan9obj implements access to Plan 9 a.out object files.
- `expvar` — Package expvar provides a standardized interface to public variables, such as operation counters in servers.
- `log` — Package log implements a simple logging package.
- `log/slog` — Package slog provides structured logging, in which log records include a message, a severity level, and various other attributes expressed as key-value pairs.
- `log/syslog` — Package syslog provides a simple interface to the system log service.
- `net/http/pprof` — Package pprof serves via its HTTP server runtime profiling data in the format expected by the pprof visualization tool.

## 测试（6）

- `testing` — Package testing provides support for automated testing of Go packages.
- `testing/fstest` — Package fstest implements support for testing implementations and users of file systems.
- `testing/iotest` — Package iotest implements Readers and Writers useful mainly for testing.
- `testing/quick` — Package quick implements utility functions to help with black box testing.
- `testing/slogtest` — Package slogtest implements support for testing implementations of log/slog.Handler.
- `testing/synctest` — Package synctest provides support for testing concurrent code.
