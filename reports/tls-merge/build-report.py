"""Embed actual acceptance logs and the resolved TLS code in the merge report."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
here = root / 'reports/tls-merge'
raw = here / 'raw'
meta = json.loads((here / 'metadata.json').read_text())
results = json.loads((raw / 'results.json').read_text())
assert len(results) == 8 and all(r['exit_code'] == 0 for r in results)
assert 'exit_code=0' in (raw / 'node-transport-test.log').read_text()
source = (root / 'packages/rustd-mail/index.js').read_text()
meta['resolved_mail_blob'] = subprocess.check_output(['git', 'hash-object', 'packages/rustd-mail/index.js'], cwd=root, text=True).strip()
(here / 'metadata.json').write_text(json.dumps(meta, indent=2) + '\n')

def section(start, end):
    offset = source.index(start)
    return source[offset:source.index(end, offset)].rstrip()

code = [
    ('NodeStreamIo 的可移除监听器', section('class NodeStreamIo {', '\n  _wake() {')),
    ('socket 交接', section('  takeSocket() {', '\nclass SmtpDataWriter')),
    ('dial / NewClient 隐式 TLS 路径', section('  static async dial(address, opts = {}) {', '\n  get serverInfo() {')),
    ('共享握手与显式 STARTTLS', section('  async _wrapTls(config = {}) {', '\n  tlsConnectionState() {')),
]
parts = [f'''# SMTP TLS 合并冲突修复与验收报告

## 结论

已将 main `{meta['merged_main']}` 合入 `ci/frozen-lockfile-and-artifacts`（原分支提交 `{meta['previous_head']}`）。唯一人工解决的冲突文件是 `packages/rustd-mail/index.js`。
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

以下代码直接从验收后的 `packages/rustd-mail/index.js` 提取。文件 Git blob：`{meta['resolved_mail_blob']}`。
''']
for title, body in code:
    parts.append(f'\n### {title}\n\n```js\n{body}\n```\n')
parts.append('''
## 验收结果

先设置任务指定的 Node/pnpm PATH，并把 mise 提供的 Go 加入 PATH；`RUSTD_GO=path`，`CARGO_BUILD_JOBS=4`。版本原始输出见 environment.log。

| 命令 | exit | 实测秒数 |
| --- | ---: | ---: |
''')
requested = {'install', 'mail-build', 'mail-test', 'typecheck', 'test'}
for result in results:
    if result['step'] in requested:
        parts.append(f"| `{result['command']}` | {result['exit_code']} | {result['elapsed_seconds']} |\n")
parts.append('''
main 还自动合入了 gotool、mime、serial 的 Rust 更新。因此在全仓测试前，用同样 `CARGO_BUILD_JOBS=4 nice -n 10` 顺序重建了这三个包，避免新 JS / fixture 加载旧 `.node`。这三次额外构建也全部 exit 0，日志一并保留。

补充验证：用 `force-node-transport.cjs` 仅在独立测试进程中选择 Windows 所用的 Node TCP transport，运行原有 SMTP 测试。没有改测试文件或任何断言。该诊断验证了 socket 所有权路径与新 TLS case 的组合；它是 Linux 上的 transport 路径验证，不代表一次 Windows runner 运行。普通 mail 测试和全仓测试均未加载该诊断脚本。

本报告的通过结论仅对应这里保存的本地命令，不复用上一轮提交的五平台 CI 结论。

## 两个未提交项与放弃内容

开工时 `git status --short` 的两项实际是 `TASK.md` 与整个历史 `reports/` 目录，不是两个源代码修改。
它们属于上一轮任务书和本地诊断证据，没有加入产品源码历史；已从 worktree 移出并完整归档至：

''')
parts.append(f"`{meta['archived_untracked']}`\n\n")
parts.append('''
旧报告和全部旧日志仍保留在该目录内。本次报告、验收脚本和原始日志会提交到任务分支。全仓测试自行重写的 containers 生成样本和 image 时间戳文件恢复为合并后的索引版本；这些测试产物不属于本次源码改动。

没有放弃任何一侧功能、TLS 测试或断言；没有增加 skip、降低阈值或改变 main 的 TLS 语义。

## 完整原始输出

每节直接嵌入对应日志文件；`exit_code` 和耗时由 subprocess 执行器记录。脚本见 run-validation.py，原始文件见 raw/。
''')
files = ['environment.log', 'preserved-contracts.log'] + [Path(r['log']).name for r in results] + ['node-transport-test.log', 'cleanup.log']
for filename in files:
    text = (raw / filename).read_text(errors='replace')
    parts.append(f'\n<details>\n<summary>{filename}</summary>\n\n````text\n{text}\n````\n\n</details>\n')
(here / 'REPORT.md').write_text(''.join(parts))
print('Wrote', here / 'REPORT.md')
