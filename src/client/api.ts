import type {
  Bootstrap,
  CachePolicy,
  RunResult,
  Scenario,
  OriginSnapshot,
  StoredPolicy,
} from '../shared/types';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error ?? ''} ${json.detail ?? ''}`.trim());
  return json as T;
}

export const api = {
  bootstrap: () => req<Bootstrap>('GET', '/api/bootstrap'),
  snapshot: (id: string) => req<OriginSnapshot & {hash: string}>('GET', `/api/snapshots/${encodeURIComponent(id)}`),
  scenario: (id: string) => req<Scenario>('GET', `/api/scenarios/${encodeURIComponent(id)}`),
  savePolicy: (policy: CachePolicy) => req<StoredPolicy>('POST', '/api/policies', policy),
  selectSlot: (side: 'a' | 'b', hash: string) =>
    req<{side: string; hash: string}>('PUT', `/api/slots/${side}`, {hash}),
  startRun: (body: {scenarioId: string; policyHashA: string; policyHashB: string}) =>
    req<RunResult & {staleA: boolean; staleB: boolean}>('POST', '/api/runs', body),
  getRun: (id: string) => req<RunResult & {staleA: boolean; staleB: boolean}>('GET', `/api/runs/${id}`),
  advance: (id: string, ticks: number) => req<RunResult>('POST', `/api/runs/${id}/advance`, {ticks}),
  seek: (id: string, tick: number) => req<RunResult>('POST', `/api/runs/${id}/seek`, {tick}),
  play: (id: string) => req<RunResult>('POST', `/api/runs/${id}/play`, {}),
  pause: (id: string) => req<RunResult>('POST', `/api/runs/${id}/pause`, {}),
  inject: (id: string, side: 'a' | 'b' | 'both', event: unknown) =>
    req<RunResult>('POST', `/api/runs/${id}/events`, {side, event}),
  cancelSide: (id: string, side: 'a' | 'b') =>
    req<RunResult>('POST', `/api/runs/${id}/cancel-side`, {side}),
};
