import {useCallback, useEffect, useRef, useState} from 'react';
import {
  FastForward,
  FlaskConical,
  Pause,
  Play,
  PlugZap,
  Radio,
  SkipForward,
  Square,
  Unplug,
  WifiOff,
} from 'lucide-react';
import type {Bootstrap, CachePolicy, RunResult, Scenario} from '../shared/types';
import {api} from './api';
import {PolicyEditor} from './PolicyEditor';
import {PairTable} from './PairTable';
import {SummaryPanel} from './SummaryPanel';
import {Timeline} from './Timeline';
import {statusLabel} from './format';

type DecoratedRun = RunResult & {staleA: boolean; staleB: boolean};

const DEFAULT_A: CachePolicy = {
  name: 'A: 长 TTL + SWR + 合并',
  maxAge: 10,
  staleWhileRevalidate: 30,
  staleIfError: 40,
  coalesce: true,
  capacity: 3,
};
const DEFAULT_B: CachePolicy = {
  name: 'B: 短 TTL，不用陈旧，不合并',
  maxAge: 2,
  staleWhileRevalidate: 0,
  staleIfError: 0,
  coalesce: false,
  capacity: 2,
};

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [draftA, setDraftA] = useState<CachePolicy>(DEFAULT_A);
  const [draftB, setDraftB] = useState<CachePolicy>(DEFAULT_B);
  const [run, setRun] = useState<DecoratedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'pairs' | 'timeline'>('pairs');
  const [slotHashes, setSlotHashes] = useState<{a?: string; b?: string}>({});
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    api.bootstrap().then(async (b) => {
      setBoot(b);
      if (b.policies[0]) setDraftA(b.policies[0].policy);
      if (b.policies[1]) setDraftB(b.policies[1].policy);
      const slots = await fetch('/api/slots').then((r) => r.json()) as {a: {hash: string}; b: {hash: string}};
      setSlotHashes({a: slots.a.hash, b: slots.b.hash});
      const scn = await api.scenario(b.scenarios[0].id);
      setScenario(scn);
    });
  }, []);

  const stopPoll = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => stopPoll, []);

  const guard = useCallback(async (action: () => Promise<DecoratedRun | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setRun(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  async function startRun() {
    if (!boot || !scenario) return;
    const [pa, pb] = await Promise.all([
      ensurePolicy(draftA),
      ensurePolicy(draftB),
    ]);
    await guard(async () =>
      api.startRun({scenarioId: scenario.id, policyHashA: pa, policyHashB: pb}),
    );
  }

  async function ensurePolicy(policy: CachePolicy): Promise<string> {
    const stored = await api.savePolicy(policy);
    return stored.hash;
  }

  const withRun = (fn: (id: string) => Promise<RunResult>) => guard(async () => {
    if (!run) return;
    return fn(run.runId) as Promise<DecoratedRun>;
  });

  function togglePlay() {
    if (!run) return;
    if (run.status !== 'running') return;
    guard(async () => {
      const next = (await api.play(run.runId)) as DecoratedRun;
      stopPoll();
      pollRef.current = window.setInterval(async () => {
        const fresh = await api.getRun(run.runId);
        setRun(fresh);
        if (fresh.status !== 'running') stopPoll();
      }, 160);
      return next;
    });
  }

  const running = run?.status === 'running';
  const terminal = run !== null && run.status !== 'running';

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>HTTP 缓存实验台 · 双策略对照</strong>
        <small>同源响应快照 · 同逻辑时钟 · 事件按请求 id 对齐</small>
        <span className="spacer"/>
        {run && <span className={`run-status status-${run.status}`}>{statusLabel(run)}</span>}
      </header>

      <section className="layout">
        <div className="policies">
          <PolicyEditor
            side="a"
            title="策略 A"
            accent="accent-a"
            draft={draftA}
            boundHash={run?.policyHashA}
            currentHash={slotHashes.a}
            disabled={busy}
            onSaved={(hash) => setSlotHashes((s) => ({...s, a: hash}))}
          />
          <PolicyEditor
            side="b"
            title="策略 B"
            accent="accent-b"
            draft={draftB}
            boundHash={run?.policyHashB}
            currentHash={slotHashes.b}
            disabled={busy}
            onSaved={(hash) => setSlotHashes((s) => ({...s, b: hash}))}
          />
        </div>

        <div className="clockbar">
          <button className="primary" onClick={startRun} disabled={busy || !scenario}>
            <Play size={14}/>启动对照运行
          </button>
          <button onClick={() => withRun((id) => api.advance(id, 1))} disabled={busy || !running}>
            <SkipForward size={14}/>推进 1 tick
          </button>
          <button onClick={() => withRun((id) => api.advance(id, 10))} disabled={busy || !running}>
            <FastForward size={14}/>推进 10
          </button>
          <button onClick={() => withRun((id) => api.seek(id, 500))} disabled={busy || !running}>
            跑到结束
          </button>
          <button onClick={togglePlay} disabled={busy || !running}><Play size={14}/>自动</button>
          <button onClick={() => withRun((id) => api.pause(id))} disabled={busy || !running}><Pause size={14}/>暂停</button>
          <span className="clock">逻辑时钟 t{run?.clockTick ?? '—'}</span>
        </div>

        <div className="controlbar">
          <span className="ctl-group">
            <label>请求 id</label>
            <select id="abort-id">
              {scenario?.requests.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.url.replace('/api/', '')}</option>)}
            </select>
          </span>
          <button disabled={busy || !running} onClick={() => inject('a', {type: 'abort', requestId: abortId()})}>
            <Square size={13}/>A 取消该请求
          </button>
          <button disabled={busy || !running} onClick={() => inject('b', {type: 'abort', requestId: abortId()})}>
            <Square size={13}/>B 取消该请求
          </button>
          <span className="sep"/>
          <button disabled={busy || !running} onClick={() => inject('both', {type: 'disconnect'})}><WifiOff size={13}/>两侧断线</button>
          <button disabled={busy || !running} onClick={() => inject('a', {type: 'disconnect'})}>A 断线</button>
          <button disabled={busy || !running} onClick={() => inject('both', {type: 'reconnect'})}><PlugZap size={13}/>两侧重连</button>
          <button disabled={busy || !running} onClick={() => inject('b', {type: 'fault', url: '/api/experiments/alpha', duration: 5})}>
            <Unplug size={13}/>B 侧注入 500 窗口
          </button>
          <span className="sep"/>
          <button className="danger" disabled={busy || !running} onClick={() => withRun((id) => api.cancelSide(id, 'a'))}>
            <Radio size={13}/>取消 A 侧
          </button>
          <button className="danger" disabled={busy || !running} onClick={() => withRun((id) => api.cancelSide(id, 'b'))}>
            <Radio size={13}/>取消 B 侧
          </button>
        </div>

        {run && slotHashes.a && run.policyHashA !== slotHashes.a && (
          <div className="stale-banner">策略 A 的草稿已更新：当前结果仍绑定旧哈希 <code>{run.policyHashA}</code> 并标记为过期；启动新运行以对照新草稿。</div>
        )}
        {run && slotHashes.b && run.policyHashB !== slotHashes.b && (
          <div className="stale-banner">策略 B 的草稿已更新：当前结果仍绑定旧哈希 <code>{run.policyHashB}</code> 并标记为过期；启动新运行以对照新草稿。</div>
        )}
        {terminal && run?.cancelSide && (
          <div className="info-banner">{run.cancelSide === 'a' ? 'A' : 'B'} 侧已取消：该侧不作为完整对照；该时刻之后的请求全部进入“未配对”清单，另一侧结果独立保留。</div>
        )}
        {error && <div className="error-banner">{error}</div>}

        {run && (
          <div className="results-grid">
            <div className="results-main">
              <div className="tabs">
                <button className={tab === 'pairs' ? 'active' : ''} onClick={() => setTab('pairs')}>请求对齐</button>
                <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>时间线</button>
              </div>
              {tab === 'pairs' ? <PairTable run={run}/> : <Timeline run={run}/>}
            </div>
            <aside className="results-side">
              <SummaryPanel run={run}/>
            </aside>
          </div>
        )}
      </section>
    </main>
  );

  function abortId(): string {
    return (document.getElementById('abort-id') as HTMLSelectElement | null)?.value ?? '';
  }

  function inject(side: 'a' | 'b' | 'both', event: unknown) {
    void withRun((id) => api.inject(id, side, event));
  }
}
