import {useState} from 'react';
import type {RunResult, Side, TimelineEvent} from '../shared/types';
import {shortUrl} from './format';

const eventLabel: Record<TimelineEvent['type'], string> = {
  request: '发起请求',
  hit: 'HIT',
  'origin:start': '回源开始',
  'origin:304': '回源 304',
  'origin:200': '回源 200',
  'origin:error': '回源失败',
  'stale:swr': 'SWR 陈旧',
  'stale:error': '故障陈旧兜底',
  evict: 'LRU 驱逐',
  'coalesce:join': '合并入队',
  disconnect: '断线',
  reconnect: '重连',
  publish: '源站更新',
  fault: '故障窗口',
  abort: '取消请求',
  'cancel-side': '整侧取消',
  'side-failed': '侧运行失败',
  complete: '客户端完成',
  warn: '警告',
};

function sideClass(side: Side | 'both') {
  return side === 'a' ? 'side-a' : side === 'b' ? 'side-b' : 'side-both';
}

export function Timeline({run}: {run: RunResult}) {
  const [filter, setFilter] = useState<Side | 'both'>('both');
  const events = run.events.filter((e) => filter === 'both' || e.side === filter || e.side === 'both');

  return (
    <div className="pane-block">
      <h3>逻辑时间线（共享逻辑时钟）</h3>
      <div className="seg">
        {(['both', 'a', 'b'] as const).map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s === 'both' ? '全部' : s === 'a' ? '仅 A' : '仅 B'}
          </button>
        ))}
        <span className="hint">共 {events.length} 个事件</span>
      </div>
      <div className="timeline">
        {events.map((e, i) => (
          <div key={i} className={`tl-row ${sideClass(e.side)} ${e.injected ? 'injected' : ''}`}>
            <span className="tl-tick">t{e.tick}</span>
            <span className="tl-side">{e.side === 'both' ? 'AB' : e.side.toUpperCase()}</span>
            <span className={`tl-type type-${e.type}`}>{eventLabel[e.type]}</span>
            <span className="tl-ref">{[e.requestId, e.url ? shortUrl(e.url) : '', e.detail].filter(Boolean).join(' · ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
