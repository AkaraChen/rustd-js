# SMTP TLS 合并冲突修复与验收报告

## 结论

已将 main `906214712a3506b047ac2e2a5db5e29dbc1e9739` 合入 `ci/frozen-lockfile-and-artifacts`（原分支提交 `8c1b7c1a27acbfe7848ce844b64e1cf4b920ff0f`）。唯一人工解决的冲突文件是 `packages/rustd-mail/index.js`。
本报告随合并提交提交到任务分支；合并提交 SHA 可由 `git log -1 --format=%H` 获取。

列出的验收命令全部 exit 0。mail 测试 18 项通过、0 失败、0 skip，包含 main 的隐式 TLS / TLS 状态 fixture 及反向 Go 对照。报告下方嵌入完整原始输出，不只提供通过摘要。

## 如何组合两边的意图

- 保留 main 的 `_wrapTls(config)`，让它只负责 TLS socket 交接、握手和状态记录。
- 保留 main 的隐式 TLS 路径：`dial` 在读取 SMTP 220 欢迎语之前调用 `_wrapTls(opts.tls)`。
- 保留 main 的显式升级顺序：`startTls` 先执行 hello 和 STARTTLS 命令，调用 `_wrapTls`，再执行 EHLO。
- 将共享握手方法的能力检查组合为 `takeFd` 或 `takeSocket` 任一可用。Unix native fd 和 Windows Node-owned socket 两条路径均保留。
- 保留具名 `_onData` / `_onError` / `_onEnd` / `_onTimeout` 监听器。Node socket 转交 TLS 前暂停读取，移除旧 reader 自己注册的监听器，并归还已经读取的剩余字节。

只取旧分支整文件会丢失 main 的隐式 TLS 路径；TLS 服务器需要先握手，不能直接等待明文欢迎语。此处保留两侧流程，没有不可调和的语义矛盾。

main 的 SMTP 测试、类型声明、Go fixture 生成器均与被合入的 main 相同。`TestNewClientWithTLS` 对应 `client-newclient-implicit-tls`，`TestTLSConnState` 对应 `client-tls-connstate`；这两个 case 及隐式 TLS AUTH/send case 均保留。`ci.yml` 与合并前任务分支完全一致，冻结安装行未改。命令证据见 preserved-contracts.log。

## 解完的相关代码

以下代码直接从验收后的 `packages/rustd-mail/index.js` 提取。文件 Git blob：`ba490c9760723d8212da9e58b1ae1893f331d592`。

### NodeStreamIo 的可移除监听器

```js
class NodeStreamIo {
  constructor(stream) {
    this._stream = stream;
    this._buf = Buffer.alloc(0);
    this._dotState = 0;
    this._lineLen = 0;
    this._ended = false;
    this._err = null;
    this._wait = [];
    this._onData = (d) => {
      this._buf = Buffer.concat([this._buf, d]);
      this._wake();
    };
    this._onError = (err) => {
      this._err = err;
      this._wake();
    };
    this._onEnd = () => {
      this._ended = true;
      this._wake();
    };
    this._onTimeout = () => {
      this._err = this._err ?? new SmtpError('smtp: connection timed out', { command: '' });
      this._wake();
    };
    stream.on('data', this._onData);
    stream.on('error', this._onError);
    stream.on('end', this._onEnd);
    stream.on('timeout', this._onTimeout);
  }
```

### socket 交接

```js
  takeSocket() {
    if (this._stream.encrypted) {
      throw new SmtpError('smtp: STARTTLS already completed', { command: 'STARTTLS' });
    }
    const stream = this._stream;
    stream.pause();
    stream.removeListener('data', this._onData);
    stream.removeListener('error', this._onError);
    stream.removeListener('end', this._onEnd);
    stream.removeListener('timeout', this._onTimeout);
    if (this._buf.length) stream.unshift(this._buf);
    this._buf = Buffer.alloc(0);
    return stream;
  }
}
```

### dial / NewClient 隐式 TLS 路径

```js
  static async dial(address, opts = {}) {
    const addr = requireString(address, 'address');
    const host = opts.host == null ? splitHostPort(addr) : requireString(opts.host, 'host');
    const timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('smtp: timeoutMs must be a number');
    let io;
    if (process.platform === 'win32') {
      // Windows SOCKET handles cannot be adopted via net.Socket({ fd }). Keep
      // ownership in Node from connect through STARTTLS; DATA framing stays native.
      const socket = await smtpCall('DIAL', new Promise((resolve, reject) => {
        const net = require('node:net');
        const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
        const s = net.createConnection({ host: splitHostPort(addr), port });
        const fail = (err) => { s.destroy(); reject(err); };
        const timedOut = () => fail(new SmtpError('smtp: connection timed out', { command: 'DIAL' }));
        s.once('error', fail);
        s.once('timeout', timedOut);
        if (timeoutMs > 0) s.setTimeout(timeoutMs);
        s.once('connect', () => {
          s.removeListener('error', fail);
          s.removeListener('timeout', timedOut);
          resolve(s);
        });
      }));
      io = new NodeStreamIo(socket);
    } else {
      const id = await smtpCall('DIAL', binding.smtpDial(addr, timeoutMs >>> 0));
      io = new NativeSmtpIo(id);
    }
    const client = new SmtpClient(io, host, timeoutMs);
    try {
      // Go NewClient sets client.tls from conn.(*tls.Conn). rustd-net fromConn is
      // gone, so dial({ tls: { implicit: true } }) is tls.Dial + NewClient.
      if (opts.tls && opts.tls.implicit) {
        await client._wrapTls(opts.tls);
      }
      await client._readResponse(220, '');
      return client;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }
```

### 共享握手与显式 STARTTLS

```js
  async _wrapTls(config = {}) {
    if (typeof this._io.takeFd !== 'function' && typeof this._io.takeSocket !== 'function') {
      throw new FeatureNotBuiltError('smtp: STARTTLS handshake not built', { command: 'STARTTLS' });
    }
    const net = require('node:net');
    const tls = require('node:tls');
    let socket;
    if (typeof this._io.takeSocket === 'function') {
      socket = this._io.takeSocket();
    } else {
      const taken = await smtpCall('STARTTLS', this._io.takeFd());
      const fd = Number(taken.fd);
      const leftover = taken.leftover ? Buffer.from(taken.leftover) : Buffer.alloc(0);
      socket = new net.Socket({ fd, readable: true, writable: true });
      if (leftover.length) socket.unshift(leftover);
    }
    if (this._timeoutMs > 0) socket.setTimeout(this._timeoutMs);
    const servername = config.serverName == null ? this._serverName : String(config.serverName);
    const tlsOpts = {
      socket,
      rejectUnauthorized: config.rejectUnauthorized !== false,
    };
    if (servername && !net.isIP(servername)) tlsOpts.servername = servername;
    if (config.ca != null) tlsOpts.ca = config.ca;
    if (servername) {
      tlsOpts.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(servername, cert);
    }
    let tlsSock;
    try {
      tlsSock = await new Promise((resolve, reject) => {
        const s = tls.connect(tlsOpts, () => resolve(s));
        const fail = (err) => reject(err);
        s.once('error', fail);
        socket.once('timeout', () => fail(new SmtpError('smtp: TLS handshake timeout', { command: 'STARTTLS' })));
      });
    } catch (err) {
      socket.destroy();
      throw mapSmtpCause(err, 'STARTTLS');
    }
    this._io = new NodeStreamIo(tlsSock);
    this._tls = true;
    this._tlsState = {
      protocol: tlsSock.getProtocol() || '',
      authorized: !!tlsSock.authorized,
      serverName: servername,
      cipher: tlsSock.getCipher() || null,
    };
  }

  async startTls(config = {}) {
    await this._hello();
    await this._cmd(220, 'STARTTLS');
    await this._wrapTls(config);
    await this._ehlo();
  }
```

## 验收结果

先设置任务指定的 Node/pnpm PATH，并把 mise 提供的 Go 加入 PATH；`RUSTD_GO=path`，`CARGO_BUILD_JOBS=4`。版本原始输出见 environment.log。

| 命令 | exit | 实测秒数 |
| --- | ---: | ---: |
| `rm -rf node_modules && pnpm install --frozen-lockfile` | 0 | 4.529 |
| `CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail build` | 0 | 15.603 |
| `CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail test` | 0 | 21.547 |
| `pnpm typecheck` | 0 | 147.153 |
| `pnpm test` | 0 | 218.462 |

main 还自动合入了 gotool、mime、serial 的 Rust 更新。因此在全仓测试前，用同样 `CARGO_BUILD_JOBS=4 nice -n 10` 顺序重建了这三个包，避免新 JS / fixture 加载旧 `.node`。这三次额外构建也全部 exit 0，日志一并保留。

补充验证：用 `force-node-transport.cjs` 仅在独立测试进程中选择 Windows 所用的 Node TCP transport，运行原有 SMTP 测试。没有改测试文件或任何断言。该诊断验证了 socket 所有权路径与新 TLS case 的组合；它是 Linux 上的 transport 路径验证，不代表一次 Windows runner 运行。普通 mail 测试和全仓测试均未加载该诊断脚本。

本报告的通过结论仅对应这里保存的本地命令，不复用上一轮提交的五平台 CI 结论。

## 两个未提交项与放弃内容

开工时 `git status --short` 的两项实际是 `TASK.md` 与整个历史 `reports/` 目录，不是两个源代码修改。
它们属于上一轮任务书和本地诊断证据，没有加入产品源码历史；已从 worktree 移出并完整归档至：

`/home/akrc/Developer/rustd-js-ci-evidence-8c1b7c1-xq_zgm08`


旧报告和全部旧日志仍保留在该目录内。本次报告、验收脚本和原始日志会提交到任务分支。全仓测试自行重写的 containers 生成样本和 image 时间戳文件恢复为合并后的索引版本；这些测试产物不属于本次源码改动。

没有放弃任何一侧功能、TLS 测试或断言；没有增加 skip、降低阈值或改变 main 的 TLS 语义。

## 完整原始输出

每节直接嵌入对应日志文件；`exit_code` 和耗时由 subprocess 执行器记录。脚本见 run-validation.py，原始文件见 raw/。

<details>
<summary>environment.log</summary>

````text
$ node --version
v24.20.0
$ pnpm --version
11.20.0
$ rustc --version
rustc 1.97.1 (8bab26f4f 2026-07-14)
$ go version
go version go1.24.13 linux/amd64
RUSTD_GO=path CARGO_BUILD_JOBS=4

````

</details>

<details>
<summary>preserved-contracts.log</summary>

````text
$ git diff --exit-code 8c1b7c1a27acbfe7848ce844b64e1cf4b920ff0f -- .github/workflows/ci.yml
exit_code=0
$ git diff --exit-code 906214712a3506b047ac2e2a5db5e29dbc1e9739 -- packages/rustd-mail/test packages/rustd-mail/index.d.ts tools/gofixtures/smtp/main.go
exit_code=0
Committed SMTP fixture retains client-newclient-implicit-tls
Committed SMTP fixture retains client-tls-connstate
Committed SMTP fixture retains client-implicit-tls-auth
Committed SMTP fixture retains client-implicit-tls-send
git ls-files --unmerged: empty

````

</details>

<details>
<summary>install.log</summary>

````text
$ rm -rf node_modules && pnpm install --frozen-lockfile
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
Scope: all 97 workspace projects
✓ Lockfile passes supply-chain policies (verified 4h ago)
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +70
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Packages are hard linked from the content-addressable store to the virtual store.
  Content-addressable store is at: /home/akrc/.local/share/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Progress: resolved 70, reused 69, downloaded 0, added 69
Progress: resolved 70, reused 70, downloaded 0, added 70, done

devDependencies:
+ @napi-rs/cli 3.9.1
+ @types/node 24.13.4
+ typescript 7.0.2

Done in 3.9s using pnpm v11.20.0

exit_code=0 elapsed_seconds=4.529

````

</details>

<details>
<summary>mail-build.log</summary>

````text
$ CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail build
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
$ napi build --platform --release --no-js --dts .generated.d.ts
   Compiling rustd-mail v0.1.0 (/home/akrc/Developer/rustd-js-ci-clean/packages/rustd-mail)
    Finished `release` profile [optimized] target(s) in 11.70s

exit_code=0 elapsed_seconds=15.603

````

</details>

<details>
<summary>mail-test.log</summary>

````text
$ CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail test
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
$ node --test test/*.test.mjs
✔ Go regenerates committed mail fixtures; native parse matches (1073.259551ms)
✔ MailHeader set/get/date/addressList and MailError kinds (2.343228ms)
✔ Go regenerates committed smtp fixtures; TS client bytes match (4938.483452ms)
✔ Go net/smtp against Node fake server matches committed clientHex (5790.301116ms)
✔ plainAuth refuses non-localhost without TLS and does not send the password (66.019891ms)
✔ AUTH LOGIN challenge/response and AUTH PLAIN localhost (70.070855ms)
✔ STARTTLS handshake, re-EHLO, then AUTH; no plaintext password (115.369476ms)
✔ startTls sets tlsConnectionState and serverInfo.tls (77.050488ms)
✔ plainAuth start matches Go TestAuth / TestAuthPlain (6.655307ms)
✔ Extension is case-insensitive like Go Client.Extension (70.922734ms)
✔ HELO fallback does not parse FEATURE the way EHLO would (Go TestHello case 5) (58.807335ms)
✔ CRAM-MD5 next() matches Go hmac-md5 vector (30.346683ms)
✔ close() then command throws and does not write MAIL (54.70386ms)
✔ DATA hangup after 354 throws and is not treated as success (15.756873ms)
✔ DATA overlong line throws and is not truncated (11.132605ms)
✔ hung banner respects timeoutMs and does not hang (262.682187ms)
✔ sendMail with AUTH after HELO-only errors instead of Go silent skip (13.506039ms)
✔ linux-x64 .node is under 2MB (1.30671ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19878.106214

exit_code=0 elapsed_seconds=21.547

````

</details>

<details>
<summary>typecheck.log</summary>

````text
$ pnpm typecheck
$ tsc --noEmit && node scripts/workspace.mjs typecheck
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json
$ tsc --noEmit -p tsconfig.json

exit_code=0 elapsed_seconds=147.153

````

</details>

<details>
<summary>rustd-gotool-build.log</summary>

````text
$ CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-gotool build
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
$ napi build --platform --release --no-js --dts .generated.d.ts
   Compiling rustd-gotool v0.1.0 (/home/akrc/Developer/rustd-js-ci-clean/packages/rustd-gotool)
warning: value assigned to `endline` is never read
   --> src/parser.rs:171:31
    |
171 |             let mut endline = 0;
    |                               ^ this value is reassigned later and never used
...
174 |                 endline = el;
    |                 ------------ `endline` is overwritten here before the previous value is read
    |
    = note: `#[warn(unused_assignments)]` (part of `#[warn(unused)]`) on by default

warning: value assigned to `i2` is never read
   --> src/scanner.rs:910:22
    |
910 |         let mut i2 = 0usize;
    |                      ^^^^^^ this value is reassigned later and never used
...
914 |                     i2 = i;
    |                     ------ `i2` is overwritten here before the previous value is read

warning: function `ident_expr` is never used
   --> src/ast.rs:267:8
    |
267 | pub fn ident_expr(name_pos: i32, name: impl Into<String>) -> Expr {
    |        ^^^^^^^^^^
    |
    = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: constant `TRACE` is never used
  --> src/parser.rs:11:11
   |
11 | pub const TRACE: u32 = 1 << 3;
   |           ^^^^^

warning: method `print_group` is never used
   --> src/print.rs:190:8
    |
 17 | impl<'a> Printer<'a> {
    | -------------------- method in this implementation
...
190 |     fn print_group(&mut self, g: &CommentGroup) -> Result<()> {
    |        ^^^^^^^^^^^

warning: function `is_operator` is never used
   --> src/token.rs:129:8
    |
129 | pub fn is_operator(tok: i32) -> bool {
    |        ^^^^^^^^^^^

warning: `rustd-gotool` (lib) generated 6 warnings
    Finished `release` profile [optimized] target(s) in 20.39s

exit_code=0 elapsed_seconds=24.102

````

</details>

<details>
<summary>rustd-mime-build.log</summary>

````text
$ CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mime build
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
$ napi build --platform --release --no-js --dts .generated.d.ts
   Compiling rustd-mime v0.1.0 (/home/akrc/Developer/rustd-js-ci-clean/packages/rustd-mime)
    Finished `release` profile [optimized] target(s) in 19.83s

exit_code=0 elapsed_seconds=24.133

````

</details>

<details>
<summary>rustd-serial-build.log</summary>

````text
$ CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-serial build
packages/_template/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/_template/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-archive/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-archive/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-checksum/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-checksum/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-compress/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-compress/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-containers/npm/darwin-x64 | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-containers/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-crypto/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-crypto/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-arm64 | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-encoding/npm/darwin-x64   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-encoding/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-gotool/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-gotool/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-image/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-arm64      | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/darwin-x64        | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/linux-arm64-gnu   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-log/npm/win32-x64-msvc    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mail/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-arm64    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/darwin-x64      | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/linux-arm64-gnu | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mathx/npm/win32-x64-msvc  | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-arm64     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/darwin-x64       | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/linux-arm64-gnu  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-mime/npm/win32-x64-msvc   | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../npm/linux-arm64-gnu                  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-regexsyntax/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-arm64   | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/darwin-x64     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-serial/npm/linux-arm64-gnu     | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-serial/npm/win32-x64-msvc | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-arm64  | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
packages/rustd-unicode/npm/darwin-x64    | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["darwin"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/linux-arm64-gnu    | [WARN] Unsupported platform: wanted: {"cpu":["arm64"],"os":["linux"],"libc":["glibc"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
.../rustd-unicode/npm/win32-x64-msvc     | [WARN] Unsupported platform: wanted: {"cpu":["x64"],"os":["win32"],"libc":["any"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
$ napi build --platform --release --no-js --dts .generated.d.ts
   Compiling rustd-serial v0.1.0 (/home/akrc/Developer/rustd-js-ci-clean/packages/rustd-serial)
    Finished `release` profile [optimized] target(s) in 19.79s

exit_code=0 elapsed_seconds=23.741

````

</details>

<details>
<summary>test.log</summary>

````text
$ pnpm test
$ node --test scripts/test/*.test.mjs && node scripts/workspace.mjs test
✔ Go checksum fixture has all 13 algorithms and matches incremental writes (377.828484ms)
✔ Go rejects corrupt JS output with a reproducer (269.862985ms)
✔ Go rejects empty verification and missing checksum fields (385.127676ms)
✔ JS rejects missing and unexpected fields with the smallest fixture context (1.164827ms)
✔ compiled Go helper executes directly from a path containing spaces (699.440576ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1337.352862
$ node --test test/*.test.mjs
✔ Go generates → native reads bytes (empty, boundaries, 1 MiB) (397.087673ms)
✔ JS generates → native output → Go verifies bytes (275.759387ms)
✔ native respects typed-array slices and returns an independent array (1.813712ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 915.627915
$ node --test test/*.test.mjs
✔ Go fixture tar entries: extract uname/gname match Go Header (2449.376887ms)
✔ Go-written uname/gname extract field-level vs Go Header (22.902234ms)
✔ tarCreate uname/gname round-trip matches Go Header; empty omitted (47.087673ms)
✔ pax uname/gname override ustar fields and match Go; atime/ctime stay off Date (10.677385ms)
✔ pax long uname/gname (>31) extract matches Go Header (28.445166ms)
✔ Go fixture zip entries: extract crc32/size/compressedSize match Go FileHeader (1974.405664ms)
✔ Go-written zip crc32/size/compressedSize extract field-level vs FileHeader (28.827854ms)
✔ zipCreate crc32/size match Go FileHeader; store compressedSize==size; deflate compressedSize vs Go dump of same bytes (27.792888ms)
✔ zip-zip64-crafted extra sizes and crc32 match Go; no archive comment API (401.89745ms)
✔ Go fixture zip entries: extract modified Date matches FileHeader.Modified UnixMilli (2035.681091ms)
✔ Go-written zip with Modified extra timestamp extracts field-level vs FileHeader.UnixMilli (32.136137ms)
✔ Go-written zip without Modified (DOS 0/0) matches FileHeader.UnixMilli 1979-11-30 (39.851879ms)
✔ zipCreate/ZipWriter modified Date round-trip vs Go FileHeader.UnixMilli (second precision) (29.415301ms)
✔ zip-zip64-crafted modified matches Go; no atime/ctime Date; no archive comment API (340.197401ms)
✔ Go fixture zip entries: extract method matches FileHeader.Method (0 store / 8 deflate) (1704.385755ms)
✔ Go-written zip method extracts field-level vs FileHeader.Method (29.362619ms)
✔ zipCreate/ZipWriter method round-trip vs Go FileHeader.Method; TS union stays 0|8 (41.132069ms)
✔ zip-zip64-crafted method matches Go; no atime/ctime Date; no archive comment API (536.199965ms)
✔ Go fixture zip entries: extract mode matches FileHeader.Mode (2081.754071ms)
✔ Go-written zip SetMode extracts field-level vs FileHeader.Mode (24.460127ms)
✔ zipCreate/ZipWriter mode round-trip vs Go FileHeader.Mode; method union stays 0|8 (28.980382ms)
✔ zip-zip64-crafted unix creator empty attrs Mode()=0; no atime/ctime Date; no archive comment API (313.968804ms)
✔ Go fixture zip entries: extract nonUtf8 matches FileHeader.NonUTF8 (2202.720572ms)
✔ Go-written zip NonUTF8 extracts field-level vs FileHeader.NonUTF8 (23.406401ms)
✔ zipCreate/ZipWriter nonUtf8 round-trip vs Go FileHeader.NonUTF8; no extra/archive comment (24.317924ms)
✔ zip-zip64-crafted ASCII+UTF8-flag is NonUTF8=false; no atime/ctime/extra/archive comment (339.280729ms)
✔ Go fixture zip entries: extract comment matches FileHeader.Comment (2248.986513ms)
✔ Go-written zip comments extract field-level vs FileHeader.Comment (25.658518ms)
✔ zipCreate/ZipWriter comment round-trip vs Go FileHeader.Comment; no extra/archive comment (32.230456ms)
✔ zip-comment fixture: entry Comment vs FileHeader; Go Reader.Comment is not a JS API (318.148497ms)
✔ zip-zip64-crafted empty comment matches Go; no atime/ctime/extra/archive comment (444.623446ms)
✔ Go fixture zip files with GPBF bit 3: comment/crc32/size/compressedSize vs FileHeader (2059.700812ms)
✔ Go-written zip CreateHeader sets GPBF bit 3; extract matches FileHeader (43.060257ms)
✔ crafted GPBF bit 3 store (with and without DD signature) vs FileHeader (42.846484ms)
✔ crafted zip64 data-descriptor (GPBF bit 3) sizes/crc32/comment vs FileHeader (16.47865ms)
✔ crafted GPBF bit 3 deflate compressedSize vs Go dump of same bytes (19.177833ms)
✔ every truncated zip prefix throws ZipFormatError (JS store/deflate + ZipReader) (13.074967ms)
✔ every truncated prefix of Go-written zip is ZipFormatError; Go Open also rejects (1585.323567ms)
✔ Go fixture zips: truncated prefixes throw ZipFormatError (594.087165ms)
✔ EOCD central-directory offset past EOF is ZipFormatError (not OOB read) (95.305891ms)
✔ central-directory local-header offset past EOF is ZipFormatError (issue #2 §4.5) (184.785999ms)
✔ JS tarCreate: TarReader 1-byte write matches tarExtract field-level (109.608263ms)
✔ JS zipCreate: ZipReader 1-byte write matches zipExtract field-level (3.783726ms)
✔ TarWriter/ZipWriter buffers: 1-byte read matches extract (16.196899ms)
✔ Go fixture archives: 1-byte Reader vs extract field-level (issue #2 §4.4) (422.104799ms)
✔ zip data-descriptor (GPBF bit 3): 1-byte ZipReader vs zipExtract (4.130037ms)
✔ every tar/zip prefix shorter than the archive is a format error (339.246075ms)
✔ GNU tar -tf and unzip -l list JS and Go archives (666.08709ms)
✔ JS tarCreate: TarReader random mid-archive splits match 1-byte and tarExtract (89.711779ms)
✔ JS zipCreate: ZipReader random mid-archive splits match 1-byte and zipExtract (4.343779ms)
✔ TarWriter/ZipWriter buffers: random mid-archive splits match 1-byte and extract (20.403165ms)
✔ Go fixture archives: random mid-archive splits vs 1-byte/extract (issue #2 §4.4) (696.995791ms)
✔ zip data-descriptor (GPBF bit 3): random mid-archive ZipReader vs 1-byte/extract (4.173503ms)
✔ JS tarCreate field-level mode/uid/gid/uname/gname/mtime vs Go dump (issue #2 §4.2) (996.273155ms)
✔ JS zipCreate field-level method/comment/crc32/size/mode/mtime vs Go FileHeader (issue #2 §4.2) (32.734891ms)
✔ TarWriter/ZipWriter.end() field-level matches create() vs Go dump (83.219116ms)
✔ JS tarCreate hardlink/fifo/char/block type+linkname vs Go dump (issue #2 §4.2) (1245.667822ms)
✔ 255-byte names, >100-char paths, and deep dirs round-trip tar and zip (4.74799ms)
✔ duplicate entry names are preserved in order for tar and zip (1.663305ms)
✔ zip central-directory local-header offset past EOF is ZipFormatError (1.60125ms)
✔ linux-x64 .node is stripped and <= 2MB (2.46692ms)
✔ npm pack loads CJS and ESM from a clean directory without shipping .node in the main tarball (6693.897662ms)
✔ Go tar-symlink/hardlink/fifo: type and linkname match Go listings (408.046628ms)
✔ Go zip-comment: entry comment round-trips; data matches (364.125136ms)
✔ Go zip-zip64-crafted: extract name and payload (zip64 extra, not 4GiB) (422.658464ms)
✔ non-UTF8 zip names keep rawName and set nonUtf8; name is not a silent replacement of the bytes (9.720961ms)
✔ GNU L/K long name and linkname are applied, not returned as entries (418.061028ms)
✔ GNU L tar via 1-byte TarReader matches tarExtract (43.809536ms)
✔ sparse tar typeflag S throws TarFormatError (3.438846ms)
✔ char and block device types round-trip and Go reads them (303.586769ms)
✔ zip data descriptor (GPBF bit 3) extracts payload; Go reads it (402.489525ms)
✔ unknown pax keys are retained on entry.pax; Go PAXRecords match (1709.557217ms)
✔ crafted pax x-header unknown keys survive extract and TarReader (639.554328ms)
✔ Go-written PAXRecords unknown keys extract onto entry.pax (564.66322ms)
✔ unknown typeflag is kept as type string; Go Typeflag matches (1569.163005ms)
✔ global pax unknown keys are retained on the x-global-header entry (628.352043ms)
✔ pax mtime fractional seconds match Go ModTime UnixMilli; atime/ctime stay on pax (1229.081174ms)
✔ TarReader matches extract for fractional pax mtime and atime/ctime pax keys (738.550518ms)
✔ Go-written fractional ModTime/AccessTime/ChangeTime extract onto mtime Date + pax atime/ctime (1336.081187ms)
✔ JS Date with millisecond fraction writes pax mtime; Go ModTime UnixMilli matches (647.285576ms)
✔ tarCreate pax atime/ctime stay on entry.pax and are not Date fields (551.089345ms)
✔ invalid pax mtime throws TarFormatError like Go ErrHeader (849.005174ms)
✔ Go fixture tar entries: extract mtime UnixMilli matches Go ModTime (1597.630646ms)
✔ integer-second ustar omits pax mtime; Go ModTime UnixMilli still matches (17.400798ms)
✔ integer-second mtime with extra pax keys still omits pax mtime (11.01961ms)
✔ TarWriter integer-second mtime omits pax mtime like tarCreate (11.139726ms)
✔ Go fixture tar entries: extract mode/uid/gid match Go Header (1558.956114ms)
✔ Go-written non-zero uid/gid extract field-level vs Go Header (29.656356ms)
✔ tarCreate uid/gid/mode round-trip matches Go Header; zero ids omitted (37.022394ms)
✔ pax uid/gid override ustar fields and match Go; atime/ctime stay off Date (11.691198ms)
✔ Go fixtures: native reads tar/zip fields and data (466.407526ms)
✔ JS archives round-trip through Go (352.111756ms)
✔ streaming tar/zip matches whole-buffer extract (4.032033ms)
✔ TarWriter/ZipWriter match create() (1.562217ms)
✔ truncated archives throw format errors, never hang (120.336708ms)
✔ zip central-directory offset past EOF is a ZipFormatError (1.188525ms)
✔ empty input and typed-array slices (1.314082ms)
ℹ tests 97
ℹ suites 0
ℹ pass 97
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10697.665105
$ node --test test/*.test.mjs
✔ Go generates checksum fixtures; native matches all 13 algorithms including incremental splits (459.923323ms)
✔ JS generates inputs → native digests → Go independently verifies (222.819441ms)
✔ one-shot helpers match streaming hashes and Go empty-input constants (3.10144ms)
✔ IEEE CRC-32 matches Node zlib.crc32; FNV-1a matches public vectors (0.662865ms)
✔ same seed and input are stable across 100 in-process runs and a child process (252.012783ms)
✔ avalanche: flipping 1 input bit flips about 32 of 64 output bits (128.855695ms)
✔ chi-square distribution of short strings mod 8/64/1024 has p > 0.01 (4778.130939ms)
ℹ maphash distribution seed=0xf203f776a1fc714b5b3a5d9304febf5a
✔ digest does not change state; reset and clone are independent (11.02046ms)
✔ crc seed continues a previous checksum; illegal poly and zero maphash seed throw (26.625337ms)
✔ maphash is process-deterministic for a serialized seed and differs across seeds (2.686492ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5388.312973
$ node --test test/*.test.mjs
✔ Go regenerates committed bzip2 fixtures; native SHA-256 matches (669.695601ms)
✔ committed testdata/*.bz2 match catalog bytes and Go SHA/error (439.323012ms)
✔ streaming bzip2 matches one-shot across split points (4.231453ms)
✔ streaming concat-hello matches one-shot across split points (7.394332ms)
✔ Go hello-9 truncation at every offset matches native error text (4.468334ms)
✔ bzip2DecompressStream matches one-shot and Bzip2Decompressor across splits (378.001154ms)
✔ bzip2DecompressStream truncated input throws Bzip2FormatError (1.455602ms)
✔ reset reuses a decompressor (27.693743ms)
✔ streaming write does not keep the full compressed input (11.360571ms)
✔ 8MiB random bzip2 streams with bounded native input (2734.40496ms)
✔ outputs are independent copies (2.885124ms)
✔ Go regenerates committed LZW fixtures; native matches compress and decompress (276.569872ms)
✔ JS-generated LZW bytes verify against Go (216.837294ms)
✔ streaming LZW matches one-shot across split points (109.255042ms)
✔ LZW leftover bits across every byte split match Go for lsb and msb (14.371049ms)
✔ LzwDecompressor.write does not keep the whole compressed stream (711.181671ms)
✔ litWidth is rejected immediately with Go wording (1.404762ms)
✔ input bytes larger than litWidth fail (0.685291ms)
✔ truncated LZW stream errors without crashing (1.00656ms)
✔ Go regenerates LZW truncation/corrupt fixtures; native error text matches (286.047194ms)
✔ typed-array slices are respected and outputs are independent (0.789741ms)
✔ 1MiB LZW matches Go compress and round-trips for all litWidth × order (4045.021182ms)
✔ lzwCompressStream matches one-shot and LzwCompressor across splits (273.007332ms)
✔ lzwCompressStream empty iterable matches one-shot empty (1.020944ms)
✔ lzwDecompressStream matches one-shot and LzwDecompressor across splits (344.66917ms)
✔ lzwDecompressStream truncated input throws LzwFormatError (1.396851ms)
✔ npm pack installs CJS and ESM with the native binary (4001.34949ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6654.778196
$ node --test --test-concurrency=1 test/*.test.mjs
{"label":"identical-a","ms":{"256KB":1.734,"1MB":8.329,"4MB":32.209},"ratio":{"1MB/256KB":4.8,"4MB/1MB":3.87},"samples":{"256KB":[1.688,1.734,1.754],"1MB":[7.675,8.329,8.741],"4MB":[31.119,32.209,40.304]}}
{"label":"pattern","ms":{"256KB":7.616,"1MB":43.709,"4MB":343.357},"ratio":{"1MB/256KB":5.74,"4MB/1MB":7.86},"samples":{"256KB":[6.954,7.616,8.044],"1MB":[38.776,43.709,46.589],"4MB":[337.518,343.357,377.286]}}
{"label":"identical-a-16","ms":{"1MB":6.823,"4MB":30.387,"16MB":142.684},"ratio":{"4MB/1MB":4.45,"16MB/4MB":4.7,"16MB/1MB":20.91},"samples":{"1MB":[6.736,6.775,6.823,6.941,7.542],"4MB":[28.384,29.157,30.387,30.569,33.463],"16MB":[127.005,139.577,142.684,144.642,149.702]}}
{"label":"pattern-16","ms":{"1MB":39.911,"4MB":435.726,"16MB":2449.011},"ratio":{"4MB/1MB":10.92,"16MB/4MB":5.62,"16MB/1MB":61.36},"samples":{"1MB":[35.93,39.517,39.911,43.562,47.109],"4MB":[284.158,390.51,435.726,478.692,502.757],"16MB":[2207.396,2329.25,2449.011,2496.408,2608.64]}}
✔ SuffixArray.build 256KB/1MB/4MB is near-linear (identical bytes) (195.138066ms)
✔ SuffixArray.build 256KB/1MB/4MB is near-linear (patterned bytes) (1719.871466ms)
✔ SuffixArray.build 1MB/4MB/16MB is near-linear (identical bytes) (1150.694981ms)
✔ SuffixArray.build 1MB/4MB/16MB is near-linear (patterned bytes) (17946.67357ms)
✔ heap empty pop is undefined; remove out of range is RangeError (2.946127ms)
✔ list remove of foreign element returns its value and leaves length (0.725361ms)
✔ list pushBackList copies values (Go semantics); nodes stay on other (0.371251ms)
✔ ring New(0) Do is 0 calls; Unlink(len) length is 3; Move(0) is self (0.528445ms)
✔ suffixarray rejects bad n, truncated/huge/zero-width payloads, and copies input (1.691651ms)
✔ List/Heap work if the native binary is absent; SuffixArray errors clearly (10.956492ms)
✔ 1 MiB identical bytes build is linear (finishes well under 5s) (16.386466ms)
✔ Go generates suffixarray/heap/list/ring fixtures; native and JS match (399.307177ms)
✔ JS write bytes → Go Read/Lookup verifies (278.792741ms)
✔ banana Lookup order matches Go (not sorted) (1.388827ms)
✔ host platform .node is present, stripped, and ≤2MB decimal (7.283928ms)
✔ npm pack CJS+ESM in a clean directory; main tarball has no .node (2768.686547ms)
✔ main tarball without native: List/Heap work; SuffixArray is NativeMissingError (1466.29542ms)
✔ writeInt helper matches Go/native 10-byte length prefix (3.806561ms)
✔ SuffixArray.read zero-width chunk throws without hang (50.889497ms)
✔ SuffixArray.read truncated payload throws without hang or huge alloc (0.917373ms)
✔ SuffixArray.read claimed 2^63 / i32::MAX length does not allocate (0.635393ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 26763.321199
$ node --test test/*.test.mjs
✔ Go 1.25 regenerates committed fixture bytes; native matches all 64 cases (1112.132705ms)
✔ JS generates different inputs → native computes → Go independently verifies; corruptions fail (556.383346ms)
✔ FIPS SHA vectors, RFC 1321 MD5 and RFC 4231 HMAC vectors (5.730033ms)
✔ sum, clone, reset, UTF-8, encodings and finalization are independent (5.273911ms)
✔ HMAC retains keyed state, not original key bytes, and resets after digest (10.622909ms)
✔ legacy defaults reject and opt-in remains local; invalid algorithms and inputs reject (1.771815ms)
✔ typed-array offsets, output ownership and native MAC comparison (1.722378ms)
✔ 1 MiB random input: all eight required chunk sizes, every Hash and HMAC (40925.395303ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 41171.151454
$ node --test test/*.test.mjs
base64 1MiB roundtrip native=2.867ms buffer=0.985ms ratio=0.34
hex 1MiB encode native=8.396ms js=38.421ms ratio=4.58
✔ base64 matches Buffer and openssl; strict rejects leftover bits (28.909772ms)
✔ base32 alphabets, padding, and remainder lengths (2.305618ms)
✔ hex errors, dump vs hexdump -C, append independence (16.70319ms)
✔ ascii85 z-shorthand, flush, and wrappers are caller-stripped (1.299397ms)
✔ varint bounds, overflow of 11 continuation bytes, schema encode (4.216882ms)
✔ marshaler duck typing and slice independence (1.197889ms)
✔ 1 MiB base64 encode/decode matches Buffer and logs throughput (194.041944ms)
✔ 64 MiB encode/decode does not OOM (345.811772ms)
✔ 1 MiB hex encode is at least 3x a handwritten JS loop (issue #7 §4.6) (795.327834ms)
✔ Go 1.25 generates encoding fixtures; native matches (241.613804ms)
✔ JS-generated encodings verify in Go (600.136095ms)
✔ Go fixtures match TS bytes; TS reads Go streams (483.386756ms)
✔ TS encodings decode in Go (242.215634ms)
✔ gob encoder streams, decoder write, maxTypeSize, and errors (16.264585ms)
✔ every truncated gob prefix fails; Go agrees; type mismatches error (396.86153ms)
✔ host platform .node is stripped and under 2MB (2.342816ms)
✔ npm pack installs CJS and ESM with the native binary (2883.479992ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3094.081434
$ node --test test/*.test.mjs
✔ Go 1.24 regenerates committed go/constant Int fixtures; native matches every case (1663.686964ms)
✔ JS MakeInt64 extras → native computes → Go verifies; corruptions fail (700.53211ms)
✔ Go 1.24 regenerates committed go/constant Int BinaryOp fixtures; native matches every case (215.097579ms)
✔ JS BinaryOp extras → native computes → Go verifies; corruptions fail (478.198419ms)
✔ constBinaryOp QUO/REM by zero is Unknown; Unknown propagates; invalid op throws (2.242291ms)
✔ Go 1.24 regenerates committed go/constant Int UnaryOp/AND_NOT/Shift fixtures; native matches every case (185.81831ms)
✔ JS UnaryOp/AND_NOT/Shift extras → native computes → Go verifies; corruptions fail (408.171982ms)
✔ constUnaryOp/constShift Unknown, invalid op/prec/s, AND_NOT vs SHL BinaryOp (2.6973ms)
✔ Go 1.24 regenerates committed go/constant Int/Float StringVal+Float64Val fixtures; native matches every case (153.774017ms)
✔ JS StringVal/Float64Val extras → native computes → Go verifies; corruptions fail (413.368664ms)
✔ Go 1.24 regenerates committed go/constant Float constCompare fixtures; native matches every case (160.356229ms)
✔ JS Float constCompare extras → native computes → Go verifies; corruptions fail (374.171636ms)
✔ Go 1.24 regenerates committed go/constant Float BinaryOp fixtures; native matches every case (403.420578ms)
✔ JS Float BinaryOp extras → native computes → Go verifies; corruptions fail (565.193298ms)
✔ Go 1.24 regenerates committed go/constant Float UnaryOp fixtures; native matches every case (145.416221ms)
✔ JS Float UnaryOp extras → native computes → Go verifies; corruptions fail (512.027409ms)
✔ constUnaryOp Float: +1/2 is 1/2; -1/2 is -1/2; integer-valued Float stays Float; XOR throws (1.564652ms)
✔ constBinaryOp Float: 1/2+1/2 is Float 1; mixed Int+Float; QUO-0 Unknown; REM throws (0.928108ms)
✔ constCompare Float vs Int uses exact Rat; 2/4 ≡ 1/2; Unknown still throws (0.748257ms)
✔ constToString Int/Float is not StringVal; Unknown is empty+ok; Float64Val signed zero (2.26791ms)
✔ Go 1.24 regenerates committed go/constant MakeFromLiteral Int/Float fixtures; native matches every case (166.288949ms)
✔ JS MakeFromLiteral extras → native computes → Go verifies; corruptions fail (554.106775ms)
✔ constMakeFromLiteral: 0x10 is Int 16; 1.5 is Float 3/2; invalid is Unknown; prec/tok throw (1.580668ms)
✔ Go 1.24 regenerates committed go/constant MakeFromLiteral CHAR fixtures; native matches every case (174.742914ms)
✔ JS MakeFromLiteral CHAR extras → native computes → Go verifies; corruptions fail (496.815735ms)
✔ constMakeFromLiteral CHAR: rune Int, tail ignored, malformed Unknown (5.656399ms)
✔ Go 1.24 regenerates committed go/constant MakeFromLiteral IMAG fixtures; native matches every case (195.925165ms)
✔ JS MakeFromLiteral IMAG extras → native computes → Go verifies; corruptions fail (550.011052ms)
✔ constMakeFromLiteral IMAG: Complex (0 + xi), no-i Unknown, leftover Unknown (1.967511ms)
✔ Go 1.24 regenerates committed go/constant MakeFromLiteral STRING fixtures; native matches every case (185.994705ms)
✔ JS MakeFromLiteral STRING extras → native computes → Go verifies; corruptions fail (550.297077ms)
✔ constMakeFromLiteral STRING: Unquote, raw CR strip, leftover Unknown (0.852311ms)
✔ constMakeInt64 rejects non-bigint and values outside int64 (0.759795ms)
✔ Go 1.24 regenerates committed go/constant Bool fixtures; native matches every case (239.773381ms)
✔ JS Bool extras → native computes → Go verifies; corruptions fail (554.585761ms)
✔ constMakeBool / BoolVal / NOT / LAND / LOR vs Go; malformed throw (2.643916ms)
✔ Go 1.24 regenerates committed go/constant Complex BinaryOp fixtures; native matches every case (234.995755ms)
✔ JS Complex BinaryOp extras → native computes → Go verifies; corruptions fail (783.165783ms)
✔ constBinaryOp Complex: 1i*1i, mixed Int, QUO-0 Unknown, REM/AND throw (2.869507ms)
✔ Go 1.24 regenerates committed go/constant Complex UnaryOp fixtures; native matches every case (274.666602ms)
✔ JS Complex UnaryOp extras → native computes → Go verifies; corruptions fail (669.167728ms)
✔ constUnaryOp Complex: +1i identity, -1i, mixed 1+1i, Unknown, XOR/NOT throw (1.572804ms)
✔ Go 1.24 regenerates committed go/constant Complex Compare fixtures; native matches every case (263.549191ms)
✔ JS Complex Compare extras → native computes → Go verifies; corruptions fail (503.376125ms)
✔ constCompareOp Complex EQL/NEQ vs Go; LSS/Bool/mixed String throw; constCompare stays numeric (3.378153ms)
✔ Go 1.24 regenerates committed go/constant String Compare fixtures; native matches every case (244.797712ms)
✔ JS String Compare extras → native computes → Go verifies; corruptions fail (505.922059ms)
✔ constCompareOp Bool EQL/NEQ vs Go; mixed/LSS throw; Unknown LSS is false; constCompare stays numeric (2.555669ms)
✔ constCompareOp String EQL/NEQ/order vs Go; mixed/ADD throw; constCompare stays numeric (0.880756ms)
✔ Go 1.24 regenerates committed go/constant ToFloat/ToComplex fixtures; native matches every case (176.976349ms)
✔ JS ToFloat/ToComplex extras → native computes → Go verifies; corruptions fail (507.028135ms)
✔ constToFloat/constToComplex vs Go: Int→Float, 0i unwraps, 1i stays Unknown, Bool/String Unknown (1.684379ms)
✔ Go 1.24 regenerates committed go/constant ToInt fixtures; native matches every case (167.922809ms)
✔ JS ToInt extras → native computes → Go verifies; corruptions fail (490.61645ms)
✔ constToIntValue vs Go: Int identity, 4/2 unwraps, 1/2 Unknown, 0i→0, Bool/String Unknown (1.040163ms)
✔ Go 1.24 regenerates committed go/version fixtures; native matches every case (1673.913746ms)
✔ JS generates extra versions → native computes → Go verifies; corruptions fail (670.426302ms)
✔ non-string versions throw TypeError before native conversion (2.500943ms)
✔ Go parse-edge fixture dump is stable (issue #28 §4.8) (1740.179762ms)
✔ native matches Go on remaining §4.8 long-line / //go:build syntax error / generic nesting (13.088788ms)
✔ JS extra §4.8 sources: Go verifies first pos, count, and declCount (308.829242ms)
✔ deep nest over the native cap reports an error and does not abort (4.944798ms)
✔ Go parse-error fixture dump is stable (1684.364137ms)
✔ GoParseError.list first position and count vs Go; partialFile decls match (issue #28 §4.5) (51.909569ms)
✔ JS extra broken sources: Go verifies first pos, count, and declCount (322.290522ms)
✔ Go parse fixture dump is stable and native ast.Fprint matches byte-for-byte (1650.437285ms)
✔ JS extra sources Fprint then Go verifies the dump packet (321.460386ms)
✔ src=null is unsupported; inspect/newIdent/isExported work (1.964495ms)
✔ TOKEN numbers match Go 1.24 iota dump in committed fixtures (1667.710504ms)
✔ native scanner matches Go dump (pos, tok, lit, line, column) on every case (143.208194ms)
✔ JS extra sources scan natively then Go verifies the dump packet (401.597361ms)
✔ scanInto reuses the result object; FileSet.iterate visits added files (2.624275ms)
✔ error handler is invoked for NUL; scanInto TypeError on bad out (1.606507ms)
ℹ tests 73
ℹ suites 0
ℹ pass 73
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15321.317079
$ node --test test/*.test.mjs
✔ PNG NoCompression and GIF NumColors encode bytes vs Go (#19 §4.5 exploration) (678.228248ms)
✔ Go fixtures exist (1.835144ms)
✔ PNG DecodeConfig and pixdump match Go testdata / pngsuite (481.160882ms)
✔ JPEG DecodeConfig matches Go for several qualities (9.755385ms)
✔ GIF DecodeConfig, first-frame pixdump, and DecodeAll structure match Go (6.953955ms)
✔ Plan9 Index and draw Over/Src still match Go (16.434741ms)
✔ drawMask Over/Src pixdump matches Go (7.932962ms)
✔ FloydSteinberg and Src quantize pixdump/indices match Go (13.402148ms)
✔ 0×0 / 1×0 / 0×1 PNG encode matches Go FormatError (1.907987ms)
✔ 1×1 / gray / fully-transparent PNG DecodeConfig+pixdump match Go (9.805984ms)
✔ every truncated prefix of the Go 1×1 PNG throws PngFormatError (10.316452ms)
✔ PNG CRC error is PngFormatError like Go invalid-crc32.png (10.792796ms)
✔ PNG zlib Adler-32 damage is PngFormatError; DecodeConfig still works (8.140565ms)
✔ JPEG missing DHT is JpegFormatError; DecodeConfig still works (10.927735ms)
✔ GIF NumberOfFrames=1 and LoopCount=1 match Go EncodeAll/DecodeAll (7.723264ms)
✔ GIF DisposalPrevious frame-reference cycle matches Go and does not hang (7.88766ms)
✔ gifEncode numColors>256 clamps like Go and pixdump matches (8.301828ms)
✔ Plan9 and WebSafe Index match Go on 1024 random NRGBA colors (349.23081ms)
✔ rect geometry matches Go empty/intersect basics (3.72244ms)
✔ RGBA set/at and subImage alias via set (2.724063ms)
✔ gray constructor and opaque (0.565022ms)
✔ plan9 palette is 256 colors (1.612217ms)
✔ png roundtrip preserves opaque pixels (1.872532ms)
✔ jpeg encode/decode config and maxPixels (6.045957ms)
✔ gif encode/decode (2.536539ms)
✔ empty PNG encode is PngFormatError (0.582438ms)
✔ draw src copies pixels (0.515955ms)
✔ malicious 100000×100000 PNG DecodeConfig RSS <10MB and Decode maxPixels (#19 §4.8) (1.740926ms)
✔ malicious GIF DecodeAll intercepts 1000 frames × large screen via maxPixels (#19 §4.8) (1.175896ms)
✔ host platform .node is stripped and under 3MB (3.70312ms)
✔ npm pack installs CJS and ESM with the native binary (3297.78059ms)
✔ TS pngEncode four CompressionLevels → Go png.Decode pixdump matches source (#19 §4.2) (1272.754629ms)
✔ TS jpegEncode → Go jpeg.Decode PSNR ≥ 40 dB vs source; not pixel-identical (#19 §4.2) (265.43265ms)
✔ TS gifEncode → Go gif.Decode pixdump matches TS gifDecode (#19 §4.2) (157.367464ms)
ℹ tests 34
ℹ suites 0
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3501.734878
$ node --test test/*.test.mjs
✔ Go regenerates log/slog/syslog bytes; native matches every case (309.447536ms)
✔ JSON does not HTML-escape (Go 1.24 slog SetEscapeHTML(false)) and keeps field order (158.649444ms)
✔ Record Add/Attrs/NumAttrs/Clone (1.107678ms)
✔ BadKeyError on odd rest args and non-string keys (1.472567ms)
✔ Fatal/Panic throw after writing and do not exit (2.007573ms)
✔ sink short-write is retried until complete (0.905253ms)
✔ UDP syslog bytes match Go framing; oversized payload throws (176.201511ms)
✔ syslogNew either connects or throws a named Unix syslog error (1.948281ms)
✔ package slog info writes through the default handler after setDefault (2.52436ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 820.431618
$ node --test test/*.test.mjs
✔ Go regenerates committed mail fixtures; native parse matches (313.365291ms)
✔ MailHeader set/get/date/addressList and MailError kinds (2.042257ms)
✔ Go regenerates committed smtp fixtures; TS client bytes match (2664.689491ms)
✔ Go net/smtp against Node fake server matches committed clientHex (3892.65937ms)
✔ plainAuth refuses non-localhost without TLS and does not send the password (61.839828ms)
✔ AUTH LOGIN challenge/response and AUTH PLAIN localhost (89.037136ms)
✔ STARTTLS handshake, re-EHLO, then AUTH; no plaintext password (110.25279ms)
✔ startTls sets tlsConnectionState and serverInfo.tls (63.319507ms)
✔ plainAuth start matches Go TestAuth / TestAuthPlain (2.06305ms)
✔ Extension is case-insensitive like Go Client.Extension (52.784705ms)
✔ HELO fallback does not parse FEATURE the way EHLO would (Go TestHello case 5) (69.587781ms)
✔ CRAM-MD5 next() matches Go hmac-md5 vector (9.203264ms)
✔ close() then command throws and does not write MAIL (23.654579ms)
✔ DATA hangup after 354 throws and is not treated as success (15.450013ms)
✔ DATA overlong line throws and is not truncated (12.106035ms)
✔ hung banner respects timeoutMs and does not hang (260.10931ms)
✔ sendMail with AUTH after HELO-only errors instead of Go silent skip (13.559233ms)
✔ linux-x64 .node is under 2MB (1.695837ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15558.034232
$ node --test test/*.test.mjs
✔ math/bits matches Go for 8-bit and 16-bit exhaustive unary ops (230.044447ms)
✔ math/bits matches Go for 32/64-bit boundary sets, rotate, and arithmetic (12.091472ms)
✔ div32/div64 throw RangeError with Go panic wording (1.762482ms)
✔ math/cmplx required signed-zero / Inf cases (679.870643ms)
✔ math/cmplx matches Go float64 bit patterns (cartesian specials + seeded random) (213.806933ms)
✔ JS-generated bit results are accepted by Go math/bits (863.088715ms)
✔ host platform .node is stripped and under 2MB (expected < 500KB after Zipf/ziggurat) (2.121461ms)
✔ npm pack installs CJS and ESM with the native binary (3644.743821ms)
✔ newPCG(1n, 2n) first three uint64 values match the issue fixture and Go (11.232181ms)
✔ PCG uint64 stream matches Go for 10k samples (seed 1,2 and 0,0) (35.619113ms)
✔ PCG MarshalBinary is 20 bytes and round-trips with Go (1.180563ms)
✔ ChaCha8 uint64 stream and 48-byte marshal match Go (35.119934ms)
✔ ChaCha8 readbuf: prefix from Go UnmarshalBinary continues the stream (0.917122ms)
✔ newChaCha8 rejects non-32-byte seeds (1.119297ms)
✔ newSource(1) first Int63 values match the issue fixture and Go (1.250752ms)
✔ v1 Int63 stream matches Go for 10k samples (NewSource(1)) (12.910991ms)
✔ v1 Float64 bit patterns match Go for 10k samples (NewSource(1)) (43.480414ms)
✔ v1 Read is deterministic and matches Go including leftover bytes (1.392713ms)
✔ v1 Seed(0) and Seed(-1) Int63 heads match Go (0.480961ms)
✔ v1 APIs throw on PCG/ChaCha8; v1 has no MarshalBinary (2.253907ms)
✔ PCG uint64N/intN family matches Go consumption (130.825428ms)
✔ PCG/ChaCha8 float32/float64 bit patterns match Go (63.157254ms)
✔ PCG perm and shuffle match Go for n=0/1/2/1000/10000 (7.080711ms)
✔ v1 int63n/int31/intn/uint32v1/float32/perm/shuffle match Go (78.679772ms)
✔ N-family and shuffle throw RangeError on Go panic inputs (0.830466ms)
✔ PCG/ChaCha8/v1 normFloat64 and expFloat64 match Go ziggurat bits (69.369541ms)
✔ Go example_test consumption: ExpFloat64/NormFloat64 after 3 float32 + 3 float64 (0.730971ms)
✔ Zipf uint64 stream matches Go for s=1.1 v=1 imax=100 (PCG and v1) (71.839815ms)
✔ seedDefault is not exported (Go math/rand/v2 has no Seed) (2.517599ms)
✔ defaultRand is a singleton auto-seeded ChaCha8, not Seed(1) / PCG(1,2) (8.056003ms)
✔ release .node stays under 2MB (expected << 500KB) (0.621761ms)
✔ JS PCG state() UnmarshalBinary in Go continues the stream (issue #21 §4.4b) (1622.342645ms)
✔ JS ChaCha8 state() UnmarshalBinary in Go continues the stream (issue #21 §4.4b) (1373.027572ms)
✔ PCG/ChaCha8 first 1_000_000 uint64 values match Go (issue #21 §4.3) (3429.203271ms)
ℹ tests 34
ℹ suites 0
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3916.725962
$ node --test test/*.test.mjs
✔ curl -H Content-Type is preserved on the wire and matches parseMediaType + Go (1619.142542ms)
✔ multipart header-count nextPart is in; ReadForm later (checkpoint 19) (1.583853ms)
✔ nextPart malformed empty-boundary / missing-colon / missing-closer vs Go (checkpoint 20) (2.003978ms)
✔ nextPart overlong boundary / header without CRLF vs Go (checkpoint 21) (3.490016ms)
✔ nextPart missing Content-Disposition vs Go (checkpoint 22) (0.878711ms)
✔ nextPart part-count 1000/1001 vs Go (checkpoint 23); ReadForm later (15.830338ms)
✔ readForm part-count 1000/1001 vs Go (checkpoint 24); file spill later (1.384059ms)
✔ readForm maxMemory non-file values vs Go (checkpoint 25); file spill later (0.687403ms)
✔ readForm file over maxMemory throws instead of Go disk spill (checkpoint 26) (1.118205ms)
✔ readForm 1-byte and mid-boundary feeds match whole-body (checkpoint 27) (3.290036ms)
✔ documented Windows registry difference: no extra lookup API (0.555547ms)
✔ builtin TypeByExtension table matches Go for web types (27.675856ms)
✔ AddExtensionType requires a leading dot and records the mapping (1.99297ms)
✔ AddExtensionType success mapping vs Go (text/* charset=utf-8 default) (1.073245ms)
✔ ExtensionsByType after AddExtensionType uses ParseMediaType justType (issue #9 §3) (1.964055ms)
✔ AddExtensionType error strings match Go (issue #9 §3) (1.106336ms)
✔ Go generates media-type, quoted-printable, RFC 2047 and extension fixtures; native matches (501.432562ms)
✔ JS generates quoted-printable and media types → Go verifies (1103.598314ms)
✔ Go ParseMediaType matches native parse of formatMediaType strings (1019.903086ms)
✔ platform default TypeByExtension / ExtensionsByType match Go (issue #9 §3) (1165.438994ms)
✔ loadSystemMimeTypes custom mime.types matches Go loadMimeFile rules (0.988503ms)
✔ loadSystemMimeTypes custom globs2 first-weight-wins and ignores globs (4.182708ms)
✔ ParseMediaType copies Go RFC 2231 continuations and quoted escapes (2.643617ms)
✔ invalid parameters throw InvalidMediaParameterError with mediaType (14.655615ms)
✔ duplicate unequal parameters fail the whole type (0.553875ms)
✔ FormatMediaType lowercases type and RFC 2231-encodes non-ASCII (17.60039ms)
✔ canonicalMIMEHeaderKey matches Go textproto.CanonicalMIMEHeaderKey table (449.772372ms)
✔ MIMEHeader Get/Set/Add/Del/Values fold keys like Go textproto.MIMEHeader (424.447616ms)
✔ nil MIMEHeader Get/Values match Go (empty, no throw) (0.313861ms)
✔ MIMEHeader is a plain Record with canonical keys (issue #9 Part.header) (0.279757ms)
✔ native MIMEHeader outputs verify against Go textproto (774.440485ms)
✔ nextPart of Go Writer one-part body matches Go NewReader (662.872753ms)
✔ nextPart of Go CreateFormField one-part body matches Go NewReader (772.301186ms)
✔ nextPart of native Writer one-part roundtrips vs Go NewReader (292.704466ms)
✔ nextPart returns null after the last part (292.00971ms)
✔ nextPart of Go Writer multi-field body matches Go NewReader (629.648317ms)
✔ nextPart of Go mixed CreateFormField+WriteField body matches Go NewReader (423.718939ms)
✔ nextPart of native Writer multi-field roundtrips vs Go NewReader (230.762929ms)
✔ nextPart keeps a body that contains the boundary without a CRLF prefix (560.611757ms)
✔ nextPart auto-decodes Content-Transfer-Encoding quoted-printable vs Go NextPart (282.861674ms)
✔ nextPart auto-decodes Content-Transfer-Encoding Quoted-PRINTABLE vs Go NextPart (220.477174ms)
✔ nextRawPart keeps quoted-printable CTE; nextPart then decodes (Go TestRawPart) (511.842879ms)
✔ nextPart leaves non-quoted-printable Content-Transfer-Encoding (199.062481ms)
✔ nextPart quoted-printable decode error is QuotedPrintableError (200.525814ms)
✔ nextPart 1-byte write matches whole-body for Go Writer fields (288.102773ms)
✔ nextPart 1-byte write matches whole-body for native createPart/createFormFile (181.290523ms)
✔ nextPart 1-byte write matches whole-body for quoted-printable CTE (217.519127ms)
✔ nextRawPart 1-byte write matches whole-body (2.310256ms)
✔ nextPart returns null (does not throw) after a 1-byte prefix (215.993085ms)
✔ nextPart random mid-boundary splits match whole-body and 1-byte for Go Writer fields (369.627633ms)
✔ nextPart random mid-boundary splits match whole-body and 1-byte for native createPart/createFormFile (184.88318ms)
✔ nextPart random mid-boundary splits match whole-body and 1-byte for quoted-printable CTE (185.512512ms)
✔ nextRawPart random mid-boundary splits match whole-body and 1-byte (2.473039ms)
✔ nextPart 10000 headers succeeds vs Go; 10001 is MessageTooLargeError (1753.514445ms)
✔ nextPart maxHeadersPerPart=3 matches GODEBUG multipartmaxheaders=3 (383.498693ms)
✔ nextPart returns null after a chunk that ends inside the opening boundary (262.052234ms)
✔ nextPart empty boundary matches Go TestNoBoundary (222.119548ms)
✔ nextPart missing-colon header matches Go textproto (180.715806ms)
✔ nextPart missing closer is null here; Go NextPart+Read is unexpected EOF (638.474802ms)
✔ nextPart RFC 70-char boundary vs Go; 71-char Reader still parses (Writer rejects) (317.335039ms)
✔ nextPart LF-only part headers (no CRLF) match Go (398.814759ms)
✔ nextPart header without blank CRLF matches Go missing-colon (205.232732ms)
✔ nextPart truncated header without newline is null; Go NextPart is EOF (158.196248ms)
✔ nextPart missing Content-Disposition is not an error vs Go (751.705149ms)
✔ nextPart mixed missing then present Content-Disposition vs Go (206.409298ms)
✔ nextPart empty Content-Disposition value vs Go (251.8051ms)
✔ nextPart quoted-printable without Content-Disposition vs Go (188.441284ms)
✔ nextPart missing Content-Disposition mid-boundary splits match whole-body (505.024689ms)
✔ nextPart 1000 parts succeeds vs Go; 1001 also succeeds (limit is ReadForm) (409.116676ms)
✔ nextPart ignores GODEBUG multipartmaxparts (ReadForm-only in Go 1.24) (188.253621ms)
✔ readForm 1000 parts succeeds vs Go; 1001 is MessageTooLargeError (387.686791ms)
✔ readForm maxParts=3 matches GODEBUG multipartmaxparts=3 (353.638729ms)
✔ readForm maxMemory header cap vs Go (name=x, 100-byte value) (433.893177ms)
✔ readForm maxMemory value body vs Go (largetext 1024 bytes) (357.343722ms)
✔ readForm maxMemory two values vs Go (hello/world) (399.218018ms)
✔ readForm maxMemory=-10MiB is MessageTooLargeError vs Go (222.465498ms)
✔ readForm file maxMemory 1024 vs Go in-memory; 1023 throws while Go spills (364.806669ms)
✔ readForm two 600-byte files share maxMemory vs Go (329.156448ms)
✔ readForm empty file fits maxMemory=0; 1-byte file throws vs Go spill (372.164733ms)
✔ readForm 1000 files succeeds vs Go; 1001 is MessageTooLargeError (379.718434ms)
✔ readForm 1-byte and mid-boundary match whole-body for mixed value+file vs Go (401.615951ms)
✔ readForm 1-byte and mid-boundary keep fake --b substring in value vs Go (361.958065ms)
✔ readForm 1-byte and mid-boundary keep fake --b-- bytes in file vs Go (410.622379ms)
✔ readForm missing-colon header matches Go on whole/1-byte/mid-boundary feeds (206.241536ms)
✔ readForm header without blank CRLF matches Go missing-colon on all feeds (210.137256ms)
✔ readForm empty boundary matches Go on whole and 1-byte feeds (235.712233ms)
✔ readForm truncated is empty here; Go unexpected EOF; feeds agree (413.543876ms)
✔ readForm missing Content-Disposition is skipped vs Go; feeds agree (171.182196ms)
✔ writeField bytes match Go multipart.Writer (fixed boundary) (390.311467ms)
✔ createFormField + write bytes match Go CreateFormField (379.136576ms)
✔ writeField one-part roundtrip vs Go multipart.NewReader (321.415126ms)
✔ createFormField one-part roundtrip vs Go NewReader (284.899192ms)
✔ setBoundary matches Go validation table (6.173196ms)
✔ fileContentDisposition matches Go CreateFormFile Content-Disposition (1139.504075ms)
✔ createFormFile bytes match Go multipart.Writer CreateFormFile (215.237947ms)
✔ createFormFile quoted names and binary body vs Go (531.485968ms)
✔ createFormFile empty filename and empty body vs Go NewReader (553.307145ms)
✔ createPart bytes match Go CreatePart with MIMEHeader Set/Add (297.386492ms)
✔ createPart empty header and raw (non-canonical) keys vs Go (464.735356ms)
✔ createPart then createFormFile mix vs Go (238.851902ms)
✔ random boundary is 60 hex chars from getrandom, not Math.random (1.184809ms)
✔ host platform .node is stripped and under 2MB (2.007043ms)
✔ npm pack installs CJS and ESM with the native binary (3731.878118ms)
✔ quoted-printable reader matches Go lax cases and 1-byte feeding (3.731083ms)
✔ quoted-printable writer binary switch changes CR/LF encoding (0.868395ms)
✔ quoted-printable rejects NUL and exposes partial decoded bytes (0.895288ms)
✔ python3 quopri encode/decode round-trips with quotedPrintable* (2662.94601ms)
✔ python3 quopri keeps lone LF; Go/native text-mode quoted-printable emits CRLF (115.945885ms)
✔ RFC 2047 encode/decode round-trips mixed header text (1.927608ms)
✔ RFC 2047 charsetReader uses TextDecoder for non-default charsets (23.842082ms)
✔ RFC 2047 invalid encoded-word throws (3.827384ms)
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20558.734759
$ node --test test/*.test.mjs
✔ Go regenerates committed compile fixtures; Prog.Inst matches field-level (431.10783ms)
✔ JS-generated compile dumps verify against Go (334.96891ms)
✔ INST_OP / EMPTY_OP match Go iota (0.545402ms)
✔ type errors (3.280489ms)
✔ Go regenerates committed emptyop fixtures; EmptyOpContext/IsWordChar match (369.044113ms)
✔ JS-generated emptyop cases verify against Go (257.08423ms)
✔ EmptyOpContext begin/end text bits (0.73028ms)
✔ IsWordChar is ASCII-only (0.439507ms)
✔ type errors (8.196583ms)
✔ ERROR_CODE strings and trigger samples match Go regexp/syntax (615.577346ms)
✔ 1500 nested parens throw ErrNestingDepth in a child process (not SIGSEGV) (124.293222ms)
✔ JS parse -> toString -> Go regexp.Compile match equals original (issue #30 §4.2) (328.116465ms)
✔ host platform .node is present, stripped, and ≤2MB decimal (4.805851ms)
✔ npm pack CJS+ESM in a clean directory; main tarball has no .node (2609.22356ms)
✔ Go regenerates committed parse fixtures; native dump and String match (445.027827ms)
✔ JS-generated parse dumps verify against Go (243.901024ms)
✔ OP/FLAGS match Go iota and Perl bitmask (0.637084ms)
✔ unicode.Properties names are invalid like Go (Categories/Scripts only) (149.619262ms)
✔ type errors (0.75717ms)
✔ Go regenerates committed simplify fixtures; dump and String match (461.754933ms)
✔ JS-generated simplify dumps verify against Go (253.997171ms)
✔ type errors (2.905064ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2945.870078
$ node --test test/*.test.mjs
✔ Go regenerates committed ASN.1 fixtures; native marshal/unmarshal match (963.864402ms)
✔ JS-generated DER verifies against Go (235.47374ms)
✔ openssl asn1parse reads native DER (23.269819ms)
✔ 1000-deep SEQUENCE errors without overflowing; 4GiB length claim is rejected (31.039787ms)
✔ params override schema tagging (0.670185ms)
✔ type errors and slice independence (0.700202ms)
✔ Go regenerates committed CSV fixtures; native read/write match (1047.819526ms)
✔ JS-generated CSV bytes verify against Go (224.552635ms)
✔ read() rejects invalid UTF-8; readBytes keeps Go bytes (1.433136ms)
✔ ReuseRecord is not implemented; each read returns a new array (1.474001ms)
✔ canonical round-trip Write(Read(csv)) matches byte-for-byte (0.654161ms)
✔ Python csv reads native writer output (47.014329ms)
✔ 1 MiB file parses without throw; empty/NUL/long field edges (46.454895ms)
✔ fieldPos out of range and slice independence (1.340872ms)
✔ host platform .node is stripped and under 2MB (2.122502ms)
✔ npm pack installs CJS and ESM with the native binary (2855.82544ms)
✔ Go regenerates committed PEM fixtures; native decode/encode match (1103.400265ms)
✔ JS-generated PEM bytes verify against Go (212.188627ms)
✔ pemDecodeAll walks concatenated blocks; null when no PEM (0.857357ms)
✔ canonical round-trip Encode(Decode(pem)) matches bytes (0.801802ms)
✔ BEGIN without END and 10k garbage do not hang; rest is original on miss (1.548978ms)
✔ openssl reads native PEM certificate DER and a generated key (99.036694ms)
✔ slice independence and type errors (1.955443ms)
✔ Go regenerates committed XML fixtures; native tokens/escape/marshal match (1005.659224ms)
✔ JS-generated XML verifies against Go (249.616855ms)
✔ xmllint parses native marshal output (15.768511ms)
✔ depth 10000 nested elements error without overflowing; truncated stream errors (67.691931ms)
✔ custom entity replacement does not loop (1.109081ms)
✔ HTML helpers, header, skip, encoder tokens, indent (2.977527ms)
✔ DefaultSpace, charsetReader, and type errors (1.524129ms)
ℹ tests 30
ℹ suites 0
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3034.417011
$ node --test test/*.test.mjs
✔ host platform .node is present, stripped, and ≤2MB decimal (2.553075ms)
✔ npm pack CJS+ESM in a clean directory; main tarball has no .node (2822.128226ms)
✔ unicode version matches Go 15.0.0 (2.009647ms)
✔ range table names equal Go exported *RangeTable set (1.509958ms)
✔ unknown table name throws instead of returning false (2.175965ms)
✔ 13 boolean predicates match Go change-point runs (endpoints + interior stride) (65.710589ms)
✔ full codepoint sweep of 13 predicates vs Go runs (8088.280835ms)
✔ isTable matches Go Is() runs for every named table (endpoints + samples) (169.144876ms)
✔ full isTable sweep vs Go Is() compact runs for every named table (2712.273808ms)
✔ tablesOf / isOneOfTables / IsSpace vs Zs (0.904541ms)
✔ simple case mapping matches Go non-identity list (42.161795ms)
✔ full codepoint sweep of ToUpper/ToLower/ToTitle/SimpleFold including identity (218.779134ms)
✔ Turkish/Azeri special case; Dutch/Lithuanian fall back to default (Go has no tables) (0.994492ms)
✔ JS simple-case differences from String.prototype (0.776802ms)
✔ utf8 DecodeRune single-byte 0x00..0xFF matches Go (1.430403ms)
✔ utf8 DecodeRune two-byte 0x80..0x7FF full + all C0-DF lead sequences match Go (44.501797ms)
✔ utf8 structural samples, RuneLen, Valid, round-trip (3.117497ms)
✔ utf8 last-rune, full-rune, runes iterator, validString (1.74906ms)
✔ utf16 encode/decode/surrogate parity with Go (1.946448ms)
✔ utf16 full codepoint + surrogate-pair DecodeRune vs Go checksums (1885.182207ms)
✔ utf8 legal encode(decode(x))==x for every valid rune; concat checksum vs Go (17097.64438ms)
✔ 1 MiB LCG byte stream: Valid, RuneCount, and recode match Go and do not hang (4812.308652ms)
✔ typed-array slices and independent encode output (7.244218ms)
✔ TextDecoder vs utf8Valid: legal UTF-8 agrees; illegal is replaced by JS (5.373337ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38391.946132

exit_code=0 elapsed_seconds=218.462

````

</details>

<details>
<summary>node-transport-test.log</summary>

````text
$ node --require /home/akrc/Developer/rustd-js-ci-clean/reports/tls-merge/force-node-transport.cjs --test test/smtp.test.mjs
✔ Go regenerates committed smtp fixtures; TS client bytes match (3771.192288ms)
✔ Go net/smtp against Node fake server matches committed clientHex (5126.82462ms)
✔ plainAuth refuses non-localhost without TLS and does not send the password (53.882798ms)
✔ AUTH LOGIN challenge/response and AUTH PLAIN localhost (97.298891ms)
✔ STARTTLS handshake, re-EHLO, then AUTH; no plaintext password (172.51656ms)
✔ startTls sets tlsConnectionState and serverInfo.tls (59.544085ms)
✔ plainAuth start matches Go TestAuth / TestAuthPlain (1.569069ms)
✔ Extension is case-insensitive like Go Client.Extension (55.834414ms)
✔ HELO fallback does not parse FEATURE the way EHLO would (Go TestHello case 5) (52.268139ms)
✔ CRAM-MD5 next() matches Go hmac-md5 vector (5.900288ms)
✔ close() then command throws and does not write MAIL (5.761623ms)
✔ DATA hangup after 354 throws and is not treated as success (14.910733ms)
✔ DATA overlong line throws and is not truncated (10.310662ms)
✔ hung banner respects timeoutMs and does not hang (274.707304ms)
✔ sendMail with AUTH after HELO-only errors instead of Go silent skip (10.615549ms)
✔ linux-x64 .node is under 2MB (3.726255ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18096.102442

exit_code=0 elapsed_seconds=18.368

````

</details>

<details>
<summary>cleanup.log</summary>

````text
packages/rustd-containers/test/go-fixtures.json: generated suffixarray samples 246 -> 1032; restored merged index version
packages/rustd-image/test/encode-bytes-compare.json: generatedAt 2026-09-14T16:32:33.278Z -> 2026-09-15T12:50:53.444Z; restored merged index version

````

</details>
