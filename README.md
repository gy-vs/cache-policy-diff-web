# HTTP Cache Lab — 双策略对照实验台

在同一份**不可变源站响应快照**与同一个**逻辑时钟**上，并行运行两套缓存策略，
按固定请求序列的请求 id 逐对齐，比较命中、回源、陈旧服务与字节传输差异。

## 运行

```bash
npm install
npm run dev      # API: http://127.0.0.1:4174  前端: http://127.0.0.1:4173
npm test         # vitest（引擎 18 项 + API 12 项）
npm run build    # tsc 类型检查 + vite 构建
```

## 设计要点

- **不可变输入快照**：`OriginSnapshot`（URL、各版本生效 tick、body 字节数、回源延迟）
  在服务端按内容哈希存储；快照只增不改。两侧仿真重放同一对象，绝不修改输入。
- **隔离缓存状态**：每侧（A/B）各自独立的缓存、在途请求与计数器，互不影响。
- **逻辑时钟**：离散 tick，可单步/多步推进、跳转、自动播放；运行期控制（断线、重连、
  abort、单侧故障）作为带 tick 的注入事件记录，整次运行可确定性复现。
- **策略内容哈希绑定**：草稿保存即按规范化 JSON 计算 sha256（`hashPolicy`）。
  运行结果记录其绑定哈希；编辑草稿会插入新哈希，**旧结果保留但标记“已过期”**，
  直到启动新运行。
- **取消一侧 ≠ 完整对照**：`cancel-side` 只终止一侧，该时刻之后该侧所有请求进入
  “未配对”清单（原因 `side_a_cancelled` / `side_b_cancelled`），另一侧结果独立保留；
  运行进入终态后控制接口锁定（409）。

## 汇总口径

- **分母**：仅统计两侧都到达终态（非取消）的请求 `summary.paired`。
- 每请求指标（命中/304/MISS/陈旧/错误/合并/回源字节/客户端字节）只在配对切片上求和。
- 被排除请求逐条列入 `summary.unpaired` 并给出原因：
  `a_cancelled` / `b_cancelled` / `both_cancelled` / `a_pending` / `b_pending` /
  `a_failed` / `b_failed` / `side_a_cancelled` / `side_b_cancelled`。
- 整侧物理资源用量（物理回源连接数、总回源字节、后台 SWR 孤儿字节、LRU 驱逐次数）
  为全量统计，**不限于配对分母**，单列展示。

## 覆盖的缓存语义

- 并发请求合并（coalesce）：冷请求不可并入条件请求（否则 304 无 body）；
  条件请求可并入全量请求。合并批次只产生一次物理回源，字节归领导者。
- 时间推进：maxAge 内 HIT；过期同步条件再验证（304 用缓存 body / 200 下载新 body）。
- stale-while-revalidate：立即返回陈旧 body，后台再验证（孤儿字节单独计量）。
- stale-if-error：回源 500 / 断线时在窗口内用陈旧 body 兜底，否则对客户端 500。
- 缓存驱逐：容量受限的 LRU，在途回源对应的条目不被驱逐。
- 源站更新：`publish` 事件注入新版本，条件请求得到 200 并刷新。
- 取消与断线重连：abort 分离在途等待者（最后一个等待者离开则丢弃该 fetch）；
  断线期间发起的请求不会发出物理回源；重连后恢复。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 快照/场景/策略哈希/运行清单 |
| GET | `/api/snapshots/:id` | 不可变快照（带内容哈希） |
| GET/POST | `/api/scenarios` | 固定请求序列与脚本事件 |
| POST | `/api/policies` | 内容寻址保存策略草稿 |
| PUT | `/api/slots/:side` | 选择 A/B 槽位当前草稿哈希 |
| POST | `/api/runs` | 以快照+两策略哈希启动对照运行 |
| POST | `/api/runs/:id/advance` `/seek` `/play` `/pause` | 逻辑时钟控制 |
| POST | `/api/runs/:id/events` | 在当前 tick 注入 abort/disconnect/reconnect/fault（可指定侧） |
| POST | `/api/runs/:id/cancel-side` | 仅取消 A 或 B 一侧 |
