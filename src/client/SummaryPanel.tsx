import type {PairMetric, RunResult} from '../shared/types';
import {fmtBytes, unpairedReasonLabel} from './format';

function MetricRow({label, metric, bytes}: {label: string; metric: PairMetric; bytes?: boolean}) {
  const better = metric.delta === 0 ? 0 : metric.delta < 0 ? -1 : 1;
  const fmt = (n: number) => (bytes ? fmtBytes(n) : String(n));
  return (
    <tr>
      <td>{label}</td>
      <td className="num col-a">{fmt(metric.a)}</td>
      <td className="num col-b">{fmt(metric.b)}</td>
      <td className={`num delta-${better === 0 ? '0' : better > 0 ? 'pos' : 'neg'}`}>
        {metric.delta === 0 ? '—' : `${metric.delta > 0 ? '+' : ''}${fmt(metric.delta)}`}
      </td>
    </tr>
  );
}

export function SummaryPanel({run}: {run: RunResult}) {
  const s = run.summary;
  const total = s.paired + s.unpaired.length;
  const reasonCounts = new Map<string, number>();
  for (const u of s.unpaired) reasonCounts.set(u.reason, (reasonCounts.get(u.reason) ?? 0) + 1);

  return (
    <div className="pane-block">
      <h3>汇总（分母 = 两侧均完成的请求）</h3>
      <div className="denom">
        <div><strong>{s.paired}</strong><span>纳入对照 / 共 {total}</span></div>
        <div><strong>{s.unpaired.length}</strong><span>未配对（排除）</span></div>
        <div className="denom-note">
          命中、回源、陈旧、字节等每请求指标只在 {s.paired} 条配对请求上计算；
          物理连接/总回源字节为整侧全量（含后台 SWR）。
        </div>
      </div>

      <table className="metric-table">
        <thead><tr><th>指标（配对切片）</th><th className="col-a">A</th><th className="col-b">B</th><th>B−A</th></tr></thead>
        <tbody>
          <MetricRow label="命中 HIT" metric={s.metrics.hits}/>
          <MetricRow label="304 再验证" metric={s.metrics.revalidated}/>
          <MetricRow label="回源 MISS(200)" metric={s.metrics.misses}/>
          <MetricRow label="陈旧服务 STALE" metric={s.metrics.stale}/>
          <MetricRow label="错误 5xx" metric={s.metrics.errors}/>
          <MetricRow label="合并受益请求" metric={s.metrics.coalesced}/>
          <MetricRow label="回源字节（前台可归因）" metric={s.metrics.originBytes} bytes/>
          <MetricRow label="客户端接收字节" metric={s.metrics.clientBytes} bytes/>
        </tbody>
      </table>

      <h4>整侧资源用量（全量，不限于配对分母）</h4>
      <table className="metric-table small">
        <thead><tr><th>项</th><th className="col-a">A</th><th className="col-b">B</th></tr></thead>
        <tbody>
          <tr><td>物理回源连接数</td><td className="num col-a">{run.resourcesA.physicalFetches}</td><td className="num col-b">{run.resourcesB.physicalFetches}</td></tr>
          <tr><td>总回源字节</td><td className="num col-a">{fmtBytes(run.resourcesA.originBytes)}</td><td className="num col-b">{fmtBytes(run.resourcesB.originBytes)}</td></tr>
          <tr><td title="后台 SWR 回源、无前台回复可归因的字节">其中：后台孤儿字节</td><td className="num col-a">{fmtBytes(run.resourcesA.orphanOriginBytes)}</td><td className="num col-b">{fmtBytes(run.resourcesB.orphanOriginBytes)}</td></tr>
          <tr><td>LRU 驱逐次数</td><td className="num col-a">{run.resourcesA.evictions}</td><td className="num col-b">{run.resourcesB.evictions}</td></tr>
        </tbody>
      </table>

      {s.unpaired.length > 0 && (
        <>
          <h4>未配对原因（分母解释）</h4>
          <ul className="reason-list">
            {[...reasonCounts.entries()].map(([reason, count]) => (
              <li key={reason}><span className="count">{count}</span>{unpairedReasonLabel[reason as keyof typeof unpairedReasonLabel]}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
