import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, Link2Off, Play, Radio, Save, Square} from 'lucide-react';

type Side = 'A' | 'B';
const SIDES: Side[] = ['A', 'B'];

type RunStateName = 'running' | 'completed' | 'cancelled' | 'failed';
type Outcome = 'hit' | 'miss' | 'revalidated' | 'stale' | 'coalesced' | 'bypass' | 'error';

interface RunEvent {
  seq: number;
  type: string;
  at?: number;
  requestId?: string;
  url?: string;
  outcome?: Outcome;
  originBytes?: number;
  clientBytes?: number;
  sizeBytes?: number;
  version?: number;
  reason?: string;
}

interface ExperimentView {
  id: string;
  createdAt: string;
  snapshotHash: string;
  snapshot: {
    requests: {id: string; at: number; method: string; url: string}[];
    origin: Record<string, {version: number; at: number; status?: number; body: string}[]>;
  };
  drafts: Record<Side, {text: string; hash: string}>;
  runs?: Partial<Record<Side, {state: RunStateName; policyHash: string; eventCount: number; error?: {message: string}}>>;
  stale?: Partial<Record<Side, boolean>>;
}

interface Summary {
  snapshotHash: string;
  policyHashes: Record<Side, string>;
  runPolicyHashes: Partial<Record<Side, string>>;
  stale: Record<Side, boolean>;
  runStates: Partial<Record<Side, RunStateName>>;
  totalRequests: number;
  paired: number;
  comparisonComplete: boolean;
  totals: Record<Side, {hits: number; misses: number; revalidated: number; stale: number; coalesced: number; bypass: number; errors: number; originFetches: number; originBytes: number; clientBytes: number}> & {originBytesDelta: number; clientBytesDelta: number};
  rows: {requestId: string; at: number; url: string; A: {outcome: string; originBytes: number; clientBytes: number}; B: {outcome: string; originBytes: number; clientBytes: number}; originBytesDelta: number}[];
  unpaired: {requestId: string; missing: Side[]; reasons: Partial<Record<Side, string>>}[];
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  hit: '命中',
  miss: '回源',
  revalidated: '304再验证',
  stale: '陈旧服务',
  coalesced: '合并',
  bypass: '直通',
  error: '错误',
};

const REASON_LABEL: Record<string, string> = {
  not_started: '该侧未启动',
  in_progress: '仍在运行',
  cancelled: '运行被取消',
  failed: '策略执行失败',
  absent: '完成但缺少事件',
};

interface SideLive {
  events: RunEvent[];
  connected: boolean;
  manualDisconnect: boolean;
}

const eventTypes = ['run_started', 'run_completed', 'run_cancelled', 'run_failed', 'time_advanced', 'origin_updated', 'evict', 'request'];

export default function App() {
  const [exp, setExp] = useState<ExperimentView | null>(null);
  const [drafts, setDrafts] = useState<Record<Side, string>>({A: '', B: ''});
  const [summary, setSummary] = useState<Summary | null>(null);
  const [live, setLive] = useState<Record<Side, SideLive>>({
    A: {events: [], connected: false, manualDisconnect: false},
    B: {events: [], connected: false, manualDisconnect: false},
  });
  const [notice, setNotice] = useState('就绪');
  const sources = useRef<Partial<Record<Side, EventSource>>>({});
  const expId = useRef<string>('lab');

  const patchLive = (side: Side, patch: Partial<SideLive>) =>
    setLive((prev) => ({...prev, [side]: {...prev[side], ...patch}}));

  const pushEvent = useCallback((side: Side, event: RunEvent) => {
    setLive((prev) => {
      const existing = prev[side].events;
      if (existing.some((e) => e.seq === event.seq)) return prev; // idempotent reconnect replay
      const events = [...existing, event].sort((a, b) => a.seq - b.seq);
      return {...prev, [side]: {...prev[side], events}};
    });
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const response = await fetch(`/api/experiments/${expId.current}/summary`);
      if (response.ok) setSummary(await response.json());
    } catch {
      /* server not ready yet */
    }
  }, []);

  // SSE subscription; EventSource auto-resumes and the server honors Last-Event-ID.
  const connect = useCallback(
    (side: Side, after = 0) => {
      sources.current[side]?.close();
      const source = new EventSource(`/api/experiments/${expId.current}/runs/${side}/events/stream?after=${after}`);
      sources.current[side] = source;
      for (const type of eventTypes) {
        source.addEventListener(type, (message: MessageEvent) => {
          pushEvent(side, JSON.parse(message.data) as RunEvent);
        });
      }
      source.onopen = () => {
        patchLive(side, {connected: true, manualDisconnect: false});
        void refreshSummary();
      };
      source.onerror = () => patchLive(side, {connected: false});
    },
    [pushEvent, refreshSummary],
  );

  const disconnect = (side: Side) => {
    sources.current[side]?.close();
    sources.current[side] = undefined;
    patchLive(side, {connected: false, manualDisconnect: true});
  };

  const load = useCallback(async () => {
    const response = await fetch('/api/experiments/lab');
    if (!response.ok) {
      setNotice(`加载实验失败：${response.status}`);
      return;
    }
    const value = (await response.json()) as ExperimentView;
    expId.current = value.id;
    setExp(value);
    setDrafts({A: value.drafts.A.text, B: value.drafts.B.text});
    // Replay existing event logs, then stay subscribed if a run is active.
    for (const side of SIDES) {
      const run = value.runs?.[side];
      const events = await (await fetch(`/api/experiments/${value.id}/runs/${side}/events?after=0`).then((r) => r.json()).catch(() => ({events: []}))) as {events: RunEvent[]};
      setLive((prev) => ({...prev, [side]: {...prev[side], events: events.events}}));
      if (run?.state === 'running') connect(side, run.eventCount);
    }
    refreshSummary();
  }, [connect, refreshSummary]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (Object.values(sources.current).some(Boolean)) refreshSummary();
    }, 800);
    return () => {
      clearInterval(timer);
      SIDES.forEach((side) => sources.current[side]?.close());
    };
  }, [load, refreshSummary]);

  const saveDraft = async (side: Side) => {
    setNotice(`保存策略 ${side}…`);
    const response = await fetch(`/api/experiments/${expId.current}/drafts/${side}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: drafts[side]}),
    });
    const value = await response.json();
    if (!response.ok) {
      setNotice(`保存失败：${value.message ?? response.statusText}`);
      return;
    }
    setNotice(value.staleMarked ? `策略 ${side} 已更新：旧结果保留，但按哈希判定为过期` : `策略 ${side} 已保存`);
    await load();
  };

  const startRuns = async (sides: Side[]) => {
    setNotice('启动对照运行…');
    for (const side of sides) setLive((prev) => ({...prev, [side]: {...prev[side], events: []}}));
    const response = await fetch(`/api/experiments/${expId.current}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({sides}),
    });
    const value = await response.json();
    if (!response.ok) {
      setNotice(`启动失败：${value.message ?? response.statusText}`);
      return;
    }
    for (const side of sides) connect(side, 0);
    setNotice('两侧运行中（共享快照与逻辑时钟，缓存状态隔离）');
  };

  const cancelRun = async (side: Side) => {
    const response = await fetch(`/api/experiments/${expId.current}/runs/${side}/cancel`, {method: 'POST'});
    setNotice(response.ok ? `已请求取消策略 ${side}，另一侧继续` : `取消失败：${(await response.json()).message}`);
    refreshSummary();
  };

  const running = useMemo(
    () => SIDES.some((side) => live[side].events.some((e) => e.type === 'run_started') && !live[side].events.some((e) => ['run_completed', 'run_cancelled', 'run_failed'].includes(e.type))),
    [live],
  );

  const shortHash = (hash?: string) => (hash ? `${hash.slice(0, 10)}…` : '—');

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>HTTP 缓存策略实验台</strong>
        <small>双策略对照 · 固定请求序列 · 不可变快照</small>
        {exp && <span className="hash" title={exp.snapshotHash}>快照 {shortHash(exp.snapshotHash)}</span>}
        {summary && (
          <span className={summary.comparisonComplete ? 'badge ok' : 'badge warn'}>
            {summary.comparisonComplete ? '对照完整' : '对照不完整'}
          </span>
        )}
        <span className="notice">{notice}</span>
      </header>

      <section className="workspace">
        <aside className="pane">
          <h2>输入快照（不可变）</h2>
          <p className="hint">同一逻辑时钟下的固定请求序列，事件按 requestId 对齐。</p>
          <h3>请求序列</h3>
          <div className="seq-list">
            {exp?.snapshot.requests.map((r) => (
              <div className="seq-row" key={r.id}>
                <code>{r.id}</code>
                <span className="t">t={r.at}</span>
                <span>{r.method}</span>
                <code>{r.url}</code>
              </div>
            ))}
          </div>
          <h3>源站版本</h3>
          <div className="seq-list">
            {exp &&
              Object.entries(exp.snapshot.origin).map(([url, versions]) =>
                versions.map((v) => (
                  <div className="seq-row origin" key={`${url}@${v.at}`}>
                    <code>{url}</code>
                    <span className="t">v{v.version} @t={v.at}</span>
                    <span>{v.body.length}B</span>
                  </div>
                )),
              )}
          </div>
        </aside>

        <section className="pane policies">
          <div className="toolbar">
            <button className="primary" onClick={() => startRuns(['A', 'B'])} disabled={running}>
              <Play size={15} />两侧同时运行
            </button>
            <button onClick={refreshSummary}>刷新汇总</button>
          </div>
          {SIDES.map((side) => {
            const runState = summary?.runStates[side] ?? exp?.runs?.[side]?.state;
            const isStale = summary ? summary.stale[side] : exp?.stale?.[side];
            const sideLive = live[side];
            return (
              <article className="policy-card" key={side}>
                <header>
                  <strong>策略 {side}</strong>
                  <span className="hash" title={exp?.drafts[side].hash}>哈希 {shortHash(exp?.drafts[side].hash)}</span>
                  {isStale && <span className="badge stale" title="草稿哈希与该次运行不一致">结果已过期</span>}
                  {runState && <span className={`badge state-${runState}`}>{runState}</span>}
                  <span className={sideLive.connected ? 'dot on' : 'dot off'} title={sideLive.connected ? 'SSE 已连接' : 'SSE 断开'} />
                </header>
                <textarea
                  aria-label={`policy-${side}`}
                  value={drafts[side]}
                  onChange={(event) => setDrafts((prev) => ({...prev, [side]: event.target.value}))}
                  spellCheck={false}
                />
                <div className="row-actions">
                  <button onClick={() => saveDraft(side)}>
                    <Save size={14} />保存草稿
                  </button>
                  <button onClick={() => startRuns([side])} disabled={runState === 'running'}>
                    <Radio size={14} />运行此侧
                  </button>
                  <button onClick={() => cancelRun(side)} disabled={runState !== 'running'}>
                    <Square size={14} />取消
                  </button>
                  {sideLive.connected ? (
                    <button onClick={() => disconnect(side)}>
                      <Link2Off size={14} />模拟断线
                    </button>
                  ) : (
                    <button onClick={() => connect(side, sideLive.events.length)}>
                      <Radio size={14} />断线重连
                    </button>
                  )}
                </div>
                <div className="ticker">
                  {sideLive.events.map((e) => (
                    <div className={`evt evt-${e.type}`} key={e.seq}>
                      <span className="seq">#{e.seq}</span>
                      {e.at !== undefined && <span className="t">t={e.at}</span>}
                      {e.requestId && <code>{e.requestId}</code>}
                      {e.outcome && <span className={`out o-${e.outcome}`}>{OUTCOME_LABEL[e.outcome]}</span>}
                      {e.type === 'evict' && <span>驱逐 {e.url} {e.sizeBytes}B</span>}
                      {e.type === 'time_advanced' && <span>时钟推进</span>}
                      {e.type === 'origin_updated' && <span>源站更新 {e.url} v{e.version}</span>}
                      {e.type === 'run_cancelled' && <span>已取消</span>}
                      {e.type === 'run_failed' && <span>失败</span>}
                      {e.type === 'run_completed' && <span>完成</span>}
                      {e.originBytes !== undefined && e.type === 'request' && <span>源{e.originBytes}B / 客户{e.clientBytes}B</span>}
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </section>

        <aside className="pane summary-pane">
          <h2>对照汇总</h2>
          {!summary ? (
            <p className="hint">运行后生成。</p>
          ) : (
            <>
              <p className="hint">
                分母：两侧均完成的请求 <strong>{summary.paired}</strong> / {summary.totalRequests}。
                {!summary.comparisonComplete && ' 本次对照不完整，下列统计仅计已配对部分。'}
              </p>
              <table className="totals">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>策略 A</th>
                    <th>策略 B</th>
                    <th>Δ (B−A)</th>
                  </tr>
                </thead>
                <tbody>
                  {([
                    ['命中', 'hits'],
                    ['回源次数', 'originFetches'],
                    ['陈旧服务', 'stale'],
                    ['304再验证', 'revalidated'],
                    ['并发合并', 'coalesced'],
                    ['源站字节', 'originBytes'],
                    ['客户端字节', 'clientBytes'],
                  ] as const).map(([label, key]) => (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>{summary.totals.A[key]}</td>
                      <td>{summary.totals.B[key]}</td>
                      <td className={key === 'originBytes' || key === 'clientBytes' ? (summary.totals[`${key}Delta`] > 0 ? 'delta-up' : 'delta-down') : ''}>
                        {key === 'originBytes'
                          ? formatDelta(summary.totals.originBytesDelta)
                          : key === 'clientBytes'
                            ? formatDelta(summary.totals.clientBytesDelta)
                            : (summary.totals.B[key] - summary.totals.A[key]).toString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>逐请求对齐</h3>
              <table className="rows">
                <thead>
                  <tr>
                    <th>requestId</th>
                    <th>A</th>
                    <th>B</th>
                    <th>源字节 Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((row) => (
                    <tr key={row.requestId}>
                      <td>
                        <code>{row.requestId}</code>
                        <small>{row.url} @t{row.at}</small>
                      </td>
                      <td className={`o-${row.A.outcome}`}>{OUTCOME_LABEL[row.A.outcome as Outcome] ?? row.A.outcome}<small>{row.A.originBytes}B</small></td>
                      <td className={`o-${row.B.outcome}`}>{OUTCOME_LABEL[row.B.outcome as Outcome] ?? row.B.outcome}<small>{row.B.originBytes}B</small></td>
                      <td className={row.originBytesDelta > 0 ? 'delta-up' : row.originBytesDelta < 0 ? 'delta-down' : ''}>{formatDelta(row.originBytesDelta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {summary.unpaired.length > 0 && (
                <>
                  <h3>未配对（{summary.unpaired.length}）及原因</h3>
                  <ul className="unpaired">
                    {summary.unpaired.map((item) => (
                      <li key={item.requestId}>
                        <code>{item.requestId}</code>
                        {item.missing.map((side) => (
                          <span key={side} className="reason">
                            缺 {side}：{REASON_LABEL[item.reasons[side] ?? ''] ?? item.reasons[side]}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

function formatDelta(delta: number): string {
  if (delta === 0) return '0';
  return delta > 0 ? `+${delta}` : `${delta}`;
}
