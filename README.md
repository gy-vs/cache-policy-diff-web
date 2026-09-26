# HTTP 缓存策略实验台

在**固定请求序列**上并排运行两套缓存策略，对比命中、回源、陈旧服务与字节传输差异。
两侧共享同一份**不可变输入快照**与**逻辑时钟**，但缓存状态完全隔离。

## 运行

```bash
npm install
npm run dev      # 前端 http://127.0.0.1:4173（代理 /api 到 4174）
npm test         # 引擎 + API 测试（含取消、断线重连）
npm run build && npm start   # 生产模式：服务端直接托管 dist
```

## 核心机制

- **不可变快照**：`POST /api/experiments` 时校验并冻结请求序列与源站版本，
  `snapshotHash = sha256(canonical JSON)`；没有任何路由能修改它。
- **内容哈希绑定**：策略草稿（JSON 文本）以 `sha256(原文)` 绑定到每次运行。
  编辑草稿后旧运行结果保留，但在汇总中标记 `stale`（草稿哈希 ≠ 运行哈希）。
- **共享逻辑时钟**：请求携带逻辑秒 `at`（非递减），引擎按 `at` 推进时钟并触发
  `time_advanced` / `origin_updated` 事件；同一 `at` 的请求构成并发组。
- **隔离缓存**：每侧一次运行一个独立的 LRU 缓存（容量、TTL、陈旧窗口、
  并发合并、条件再验证均由策略草稿决定）。
- **按 requestId 对齐**：事件携带原始请求 id，汇总只统计**两侧均完成**的请求，
  其余进入 `unpaired` 并给出原因（`not_started` / `in_progress` / `cancelled` /
  `failed` / `absent`）。取消一侧不会把另一侧当成完整对照。
- **断线重连**：事件流支持 SSE（`Last-Event-ID` 续传）与轮询（`?after=seq`），
  重连后不重不漏。

## 种子场景（实验 `lab`）

固定 12 个请求覆盖：同刻并发（r1–r3 合并）、容量驱逐（700B LRU）、TTL 过期与
304 再验证、源站版本更新（`/a` v2 @ t=50）、陈旧服务窗口、超容量对象直通。
策略 A = 合并并发 + 条件再验证；策略 B = 不合并 + 陈旧服务，两者产生可对比差异。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/experiments` / `/:id` | 列表 / 详情（含哈希与运行状态） |
| POST | `/api/experiments` | 以快照创建实验（201） |
| PUT | `/api/experiments/:id/drafts/:side` | 更新草稿，返回哈希与 `staleMarked` |
| POST | `/api/experiments/:id/runs` | 启动运行 `{sides, stepDelayMs}`（202） |
| POST | `/api/experiments/:id/runs/:side/cancel` | 取消一侧（运行中才允许） |
| GET | `/api/experiments/:id/runs/:side/events?after=` | 轮询事件 |
| GET | `/api/experiments/:id/runs/:side/events/stream` | SSE，支持 `Last-Event-ID` |
| GET | `/api/experiments/:id/summary` | 配对汇总（分母、未配对原因、字节差） |

策略草稿字段：`capacityBytes`、`defaultTtlSeconds`、`respectOriginHeaders`、
`serveStale`、`staleWindowSeconds`、`coalesceConcurrent`、`conditionalRevalidate`，
以及故障注入 `failAtRequestId`（用于演示一侧失败）。
