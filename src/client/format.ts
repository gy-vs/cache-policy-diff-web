import type {Outcome, RunResult, SideRequestResult, UnpairedReason} from '../shared/types';

export const outcomeLabel: Record<Outcome, string> = {
  hit: '命中 HIT',
  revalidated: '304 再验证',
  miss: '回源 MISS(200)',
  stale: '陈旧响应 STALE',
  error: '失败 5xx',
  cancelled: '已取消',
};

export const outcomeClass: Record<Outcome, string> = {
  hit: 'o-hit',
  revalidated: 'o-reval',
  miss: 'o-miss',
  stale: 'o-stale',
  error: 'o-error',
  cancelled: 'o-cancel',
};

export const unpairedReasonLabel: Record<UnpairedReason, string> = {
  a_missing: 'A 侧无结果',
  b_missing: 'B 侧无结果',
  a_cancelled: '仅 A 侧请求被取消',
  b_cancelled: '仅 B 侧请求被取消',
  both_cancelled: '两侧均取消',
  a_pending: 'A 侧尚未完成（时钟未到）',
  b_pending: 'B 侧尚未完成（时钟未到）',
  a_failed: 'A 侧运行失败',
  b_failed: 'B 侧运行失败',
  side_a_cancelled: 'A 侧整侧已取消',
  side_b_cancelled: 'B 侧整侧已取消',
};

export function shortUrl(url: string): string {
  return url.replace('/api/experiments/', '').replace('/api/', '');
}

export function fmtBytes(n: number): string {
  if (n === 0) return '0';
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

/** A compact one-line description of a per-side result for tooltips/details. */
export function describeResult(r: SideRequestResult | undefined): string {
  if (!r) return '—';
  const bits = [outcomeLabel[r.outcome]];
  if (r.coalesced) bits.push('合并');
  if (r.originBytes) bits.push(`回源${fmtBytes(r.originBytes)}`);
  if (r.revision !== null) bits.push(`rev${r.revision}`);
  if (r.note) bits.push(r.note);
  return bits.join(' · ');
}

export function statusLabel(run: RunResult): string {
  switch (run.status) {
    case 'running': return '运行中';
    case 'complete': return '已完成';
    case 'cancelled': return `${run.cancelSide === 'a' ? 'A' : 'B'} 侧已取消`;
    case 'failed': return `${run.errorSide === 'a' ? 'A' : 'B'} 侧失败`;
  }
}
