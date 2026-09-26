import {
  byteLength,
  InputSnapshot,
  Outcome,
  PolicyConfig,
  RequestSpec,
  RunEvent,
  Side,
} from './domain';

export const REVALIDATE_BYTES = 64; // 304 responses carry headers only

export interface EngineSink {
  emit(event: Omit<RunEvent, 'seq'>): void;
  cancelled(): boolean;
  stepDelayMs: number;
}

export interface EngineResult {
  state: 'completed' | 'cancelled' | 'failed';
  error?: {code: string; message: string};
}

interface CacheEntry {
  url: string;
  body: string;
  status: number;
  version: number;
  etag?: string;
  storedAt: number;
  expiresAt: number;
  sizeBytes: number;
  lastUsedAt: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ttlOf(headers: Record<string, string>, policy: PolicyConfig): number {
  if (policy.respectOriginHeaders) {
    const match = /(?:^|,)\s*max-age=(\d+)/.exec(headers['cache-control'] ?? '');
    if (match) return Number(match[1]);
  }
  return policy.defaultTtlSeconds;
}

/**
 * Runs one side of an experiment against the immutable snapshot.
 * Both sides execute this same deterministic function with the same snapshot
 * and the same logical clock; only the policy (and thus cache state) differs.
 */
export async function executeRun(
  snapshot: InputSnapshot,
  policy: PolicyConfig,
  side: Side,
  sink: EngineSink,
): Promise<EngineResult> {
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;
  let clock = 0;

  const emit = sink.emit.bind(sink);

  const versionAt = (url: string, t: number) => {
    const versions = snapshot.origin[url];
    let live = versions[0];
    for (const v of versions) {
      if (v.at <= t) live = v;
      else break;
    }
    return live;
  };

  const touch = (entry: CacheEntry, t: number) => {
    entry.lastUsedAt = t;
  };

  const evictFor = (incoming: number, requestId: string, at: number) => {
    while (cacheBytes + incoming > policy.capacityBytes && cache.size > 0) {
      let victim: CacheEntry | undefined;
      for (const entry of cache.values()) {
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
      }
      if (!victim) break;
      cache.delete(victim.url);
      cacheBytes -= victim.sizeBytes;
      emit({type: 'evict', requestId, at, url: victim.url, sizeBytes: victim.sizeBytes, reason: 'capacity'});
    }
  };

  const store = (request: RequestSpec, version: {version: number; status?: number; headers: Record<string, string>; body: string}): boolean => {
    const sizeBytes = byteLength(version.body);
    if (sizeBytes > policy.capacityBytes) return false; // uncacheable: fetched, never stored
    const previous = cache.get(request.url);
    if (previous) {
      cache.delete(request.url);
      cacheBytes -= previous.sizeBytes;
    }
    evictFor(sizeBytes, request.id, request.at);
    const entry: CacheEntry = {
      url: request.url,
      body: version.body,
      status: version.status ?? 200,
      version: version.version,
      etag: version.headers.etag,
      storedAt: request.at,
      expiresAt: request.at + ttlOf(version.headers, policy),
      sizeBytes,
      lastUsedAt: request.at,
    };
    cache.set(request.url, entry);
    cacheBytes += sizeBytes;
    return true;
  };

  const refresh = (entry: CacheEntry, version: {headers: Record<string, string>}, t: number) => {
    entry.storedAt = t;
    entry.expiresAt = t + ttlOf(version.headers, policy);
    entry.lastUsedAt = t;
  };

  const stats = {
    requests: 0,
    hits: 0,
    misses: 0,
    revalidated: 0,
    stale: 0,
    coalesced: 0,
    bypass: 0,
    errors: 0,
    originBytes: 0,
    clientBytes: 0,
    originFetches: 0,
  };

  const finish = (state: EngineResult['state'], extra: Record<string, unknown> = {}): EngineResult => {
    if (state === 'completed') emit({type: 'run_completed', at: clock, detail: {...stats}});
    else if (state === 'cancelled') emit({type: 'run_cancelled', at: clock, detail: {processed: stats.requests, ...extra}});
    else emit({type: 'run_failed', at: clock, detail: extra});
    return {state, ...(state === 'failed' ? {error: extra as {code: string; message: string}} : {})};
  };

  emit({type: 'run_started', detail: {side}});

  // Group by logical send time; equal `at` means concurrent on the shared clock.
  const groups = new Map<number, RequestSpec[]>();
  for (const request of snapshot.requests) {
    const group = groups.get(request.at);
    if (group) group.push(request);
    else groups.set(request.at, [request]);
  }

  for (const [at, group] of groups) {
    if (sink.cancelled()) return finish('cancelled');
    if (at > clock) {
      emit({type: 'time_advanced', at, detail: {from: clock, to: at}});
      for (const [url, versions] of Object.entries(snapshot.origin)) {
        for (const v of versions) {
          if (v.at > clock && v.at <= at) emit({type: 'origin_updated', at: v.at, url, version: v.version});
        }
      }
      clock = at;
    }

    // In-flight fetches for this concurrency group, keyed by url.
    const inflight = new Map<string, {clientBytes: number; status: number; version: number}>();

    for (const request of group) {
      if (sink.cancelled()) return finish('cancelled');
      if (policy.failAtRequestId === request.id) {
        return finish('failed', {code: 'policy_crashed', message: `policy fault injected at ${request.id}`, requestId: request.id});
      }

      let outcome: Outcome;
      let status = 200;
      let versionNum: number | undefined;
      let originBytes = 0;
      let clientBytes = 0;
      let fetched = false;
      let cached = false;
      const detail: Record<string, unknown> = {};

      if (request.method !== 'GET') {
        // Non-GET: pass through to origin, never stored, never coalesced.
        const v = versionAt(request.url, at);
        status = v.status ?? 200;
        versionNum = v.version;
        originBytes = byteLength(v.body);
        clientBytes = originBytes;
        fetched = true;
        outcome = 'bypass';
      } else {
        const entry = cache.get(request.url);
        const pending = inflight.get(request.url);
        if (pending && policy.coalesceConcurrent) {
          // Join the in-flight fetch of a sibling request in this group.
          outcome = 'coalesced';
          status = pending.status;
          versionNum = pending.version;
          clientBytes = pending.clientBytes;
          detail.coalescedWith = request.url;
          const stored = cache.get(request.url);
          if (stored) touch(stored, at);
        } else if (pending) {
          // Coalescing disabled: a concurrent miss goes to origin on its own,
          // even though a sibling in the same tick just stored the object.
          const v = versionAt(request.url, at);
          status = v.status ?? 200;
          versionNum = v.version;
          fetched = true;
          detail.uncoalesced = true;
          if (status >= 500) {
            outcome = 'error';
            originBytes = byteLength(v.body);
            clientBytes = originBytes;
          } else {
            outcome = 'miss';
            originBytes = byteLength(v.body);
            clientBytes = originBytes;
            cached = store(request, v);
          }
          inflight.set(request.url, {clientBytes, status, version: versionNum ?? 0});
        } else if (entry && at < entry.expiresAt) {
          outcome = 'hit';
          status = entry.status;
          versionNum = entry.version;
          clientBytes = entry.sizeBytes;
          touch(entry, at);
        } else if (entry && policy.serveStale && at - entry.expiresAt <= policy.staleWindowSeconds) {
          outcome = 'stale';
          status = entry.status;
          versionNum = entry.version;
          clientBytes = entry.sizeBytes;
          detail.expiredBy = at - entry.expiresAt;
          touch(entry, at);
        } else {
          // Miss, or expired without a usable stale: go to origin.
          const v = versionAt(request.url, at);
          status = v.status ?? 200;
          versionNum = v.version;
          fetched = true;
          if (status >= 500) {
            if (entry && policy.serveStale && at - entry.expiresAt <= policy.staleWindowSeconds) {
              outcome = 'stale';
              status = entry.status;
              versionNum = entry.version;
              clientBytes = entry.sizeBytes;
              detail.staleIfError = true;
              detail.expiredBy = at - entry.expiresAt;
              touch(entry, at);
              originBytes = byteLength(v.body);
            } else {
              outcome = 'error';
              originBytes = byteLength(v.body);
              clientBytes = originBytes;
            }
          } else if (entry && policy.conditionalRevalidate && entry.etag && v.headers.etag === entry.etag) {
            outcome = 'revalidated';
            originBytes = REVALIDATE_BYTES;
            clientBytes = entry.sizeBytes;
            status = entry.status;
            versionNum = entry.version;
            refresh(entry, v, at);
          } else {
            outcome = 'miss';
            originBytes = byteLength(v.body);
            clientBytes = originBytes;
            cached = store(request, v);
          }
          // Register the in-flight fetch so siblings in this tick can coalesce
          // (or, with coalescing off, at least recognize the collision).
          if (request.method === 'GET' && (outcome === 'miss' || outcome === 'error')) {
            inflight.set(request.url, {clientBytes, status, version: versionNum ?? 0});
          }
        }
      }

      stats.requests += 1;
      stats.originBytes += originBytes;
      stats.clientBytes += clientBytes;
      if (fetched) stats.originFetches += 1;
      if (outcome === 'hit') stats.hits += 1;
      else if (outcome === 'miss') stats.misses += 1;
      else if (outcome === 'revalidated') stats.revalidated += 1;
      else if (outcome === 'stale') stats.stale += 1;
      else if (outcome === 'coalesced') stats.coalesced += 1;
      else if (outcome === 'bypass') stats.bypass += 1;
      else stats.errors += 1;

      emit({
        type: 'request',
        at,
        requestId: request.id,
        url: request.url,
        outcome,
        status,
        version: versionNum,
        originBytes,
        clientBytes,
        detail: {...detail, cached, cacheBytes, cacheEntries: cache.size},
      });
      if (sink.stepDelayMs > 0) await sleep(sink.stepDelayMs);
    }
  }

  return finish('completed');
}
