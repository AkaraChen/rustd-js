# rustd-js

把 **Go 标准库有、Node 里缺**的能力，做成 Node-API 原生扩展暴露给 JS。

| | |
| --- | --- |
| 范围清单 | [issue #1](../../issues/1) —— 162 个包的总清单（117 个完全缺失 + 45 个部分覆盖） |
| 判定数据 | [`scope/`](scope/) —— Go 标准库 173 个包 × Web 平台最小公共 API（Ecma TC55 / ECMA-429 2025 快照）逐包对照 |

现状：范围已落地，实现未开始。

## scope/ 里有什么

| 文件 | 内容 |
| --- | --- |
| `README.md` | 统计与结论 |
| `go-stdlib-vs-wintertc.csv` | 173 行逐包判定（Go 包 / 分类 / 状态 / 对应项 / 说明） |
| `gaps-only.csv` | 同上，只保留 162 个有缺口的 |
| `list-go-stdlib.md` | Go 侧 173 个包与一句话简介（go1.25.6 `go list std`） |
| `list-wintertc-ecma-429.md` | 对照基准：ECMA-429 全部 73 项条目 |
| `missing-in-wintertc.md` | 缺口按能力域整理成文 |

## 口径

三档判定，**按能力算不按名字算**：

- ✅ 有等价能力 —— 现成能用（含 ECMAScript 语言层强制的部分），不做
- 🟡 有对应但更窄 —— 有，但只能干一半（整块 vs 流式、只有客户端 vs 也要服务端、单格式 vs 全格式…），补窄口
- ❌ 完全没有 —— 没有任何东西能承担，从零做

`scope/` 是对照 ECMA-429 得出的结论，不是对 Go 标准库的评论。

## Native extension development

Use Node 24, pnpm 11.20.0, Rust 1.97.1 and Go 1.24.13 (`mise exec -- go`).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:go
pnpm check:size
pnpm test:pack
```

The initial workspace includes a private native transport template and real Go
fixture tooling. Public package implementations are tracked separately in the
GitHub sub-issues. See [package conventions](docs/CONVENTIONS.md).
