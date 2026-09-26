import type {PairRow, RunResult, SideRequestResult} from '../shared/types';
import {describeResult, fmtBytes, outcomeClass, outcomeLabel, shortUrl, unpairedReasonLabel} from './format';

function Cell({r}: {r: SideRequestResult | undefined}) {
  if (!r) return <td className="cell missing">—</td>;
  return (
    <td className="cell">
      <span className={`outcome ${outcomeClass[r.outcome]}`} title={describeResult(r)}>
        {outcomeLabel[r.outcome]}
      </span>
      <span className="cell-meta">
        t{r.issuedTick}{r.completedTick !== null && r.completedTick !== r.issuedTick ? `→t${r.completedTick}` : ''}
        {r.coalesced ? ' · 合并' : ''}
        {r.originBytes > 0 ? ` · 回源${fmtBytes(r.originBytes)}` : ''}
        {r.revision !== null ? ` · rev${r.revision}` : ''}
      </span>
      {r.note && <span className="cell-note">{r.note}</span>}
    </td>
  );
}

export function PairTable({run}: {run: RunResult}) {
  const pairedIds = new Set(run.pairs.map((p) => p.requestId));
  return (
    <div className="pane-block">
      <h3>按请求 id 对齐（共 {run.pairs.length + run.unpaired.length} 条）</h3>
      <table className="pair-table">
        <thead>
          <tr>
            <th>id</th><th>URL</th><th>tick</th>
            <th className="col-a">策略 A</th><th className="col-b">策略 B</th><th>差异</th>
          </tr>
        </thead>
        <tbody>
          {run.pairs.map((pair: PairRow) => (
            <tr key={pair.requestId} className={pair.a.outcome === pair.b.outcome ? '' : 'diff-row'}>
              <td className="mono">{pair.requestId}</td>
              <td>{shortUrl(pair.url)}</td>
              <td className="mono">{pair.tick}</td>
              <Cell r={pair.a}/>
              <Cell r={pair.b}/>
              <td>{pair.a.outcome === pair.b.outcome
                ? (pair.a.originBytes === pair.b.originBytes ? '' : <span className="delta">字节差 {fmtBytes(Math.abs(pair.a.originBytes - pair.b.originBytes))}</span>)
                : <span className="delta">结果不同</span>}</td>
            </tr>
          ))}
          {run.unpaired.map((u) => (
            <tr key={u.requestId} className="unpaired-row">
              <td className="mono">{u.requestId}</td>
              <td>{shortUrl(u.url)}</td>
              <td className="mono">{u.tick}</td>
              <Cell r={u.a}/>
              <Cell r={u.b}/>
              <td><span className="unpaired-reason" title="该请求不进入汇总分母">{unpairedReasonLabel[u.reason]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      {pairedIds.size === 0 && <p className="hint">时钟尚未推进到任何请求，或两侧均未完成任何请求。</p>}
    </div>
  );
}
