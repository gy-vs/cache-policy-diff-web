import {describe, expect, it} from 'vitest';
import {executeRun, REVALIDATE_BYTES} from '../src/server/engine';
import {InputSnapshot, PolicyConfig, RunEvent, seedSnapshot} from '../src/server/domain';

const basePolicy: PolicyConfig = {
  capacityBytes: 700,
  defaultTtlSeconds: 20,
  respectOriginHeaders: true,
  serveStale: false,
  staleWindowSeconds: 0,
  coalesceConcurrent: true,
  conditionalRevalidate: true,
};

const stalePolicy: PolicyConfig = {
  ...basePolicy,
  serveStale: true,
  staleWindowSeconds: 30,
  coalesceConcurrent: false,
  conditionalRevalidate: false,
};

interface Harness {
  events: RunEvent[];
  cancelled: boolean;
  stepDelayMs: number;
}

async function run(snapshot: InputSnapshot, policy: PolicyConfig, harness?: Partial<Harness>) {
  const events: RunEvent[] = [];
  const state = {cancelled: false, ...harness};
  const result = await executeRun(snapshot, policy, 'A', {
    emit: (event) => events.push({...event, seq: events.length + 1}),
    cancelled: () => state.cancelled,
    stepDelayMs: state.stepDelayMs ?? 0,
  });
  return {result, events};
}

const requestsOf = (events: RunEvent[]) => events.filter((e) => e.type === 'request');
const byId = (events: RunEvent[], id: string) => requestsOf(events).find((e) => e.requestId === id);

describe('engine: concurrent request coalescing', () => {
  it('coalesces same-tick misses into one origin fetch when enabled', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    expect(byId(events, 'r1')?.outcome).toBe('miss');
    expect(byId(events, 'r2')?.outcome).toBe('coalesced');
    expect(byId(events, 'r3')?.outcome).toBe('coalesced');
    const originBytes = requestsOf(events)
      .filter((e) => ['r1', 'r2', 'r3'].includes(e.requestId ?? ''))
      .reduce((sum, e) => sum + (e.originBytes ?? 0), 0);
    expect(originBytes).toBe(400); // one fetch serves three clients
  });

  it('sends every concurrent miss to origin when coalescing is off', async () => {
    const {events} = await run(seedSnapshot(), stalePolicy);
    expect(byId(events, 'r2')?.outcome).toBe('miss');
    expect(byId(events, 'r3')?.outcome).toBe('miss');
    const originBytes = requestsOf(events)
      .filter((e) => ['r1', 'r2', 'r3'].includes(e.requestId ?? ''))
      .reduce((sum, e) => sum + (e.originBytes ?? 0), 0);
    expect(originBytes).toBe(1200);
  });
});

describe('engine: cache eviction', () => {
  it('evicts LRU entries on capacity pressure and re-fetches evicted urls', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    const evictions = events.filter((e) => e.type === 'evict');
    expect(evictions.map((e) => e.url)).toContain('/a'); // evicted by /c at t=6
    expect(evictions.map((e) => e.url)).toContain('/b'); // evicted when /a returns at t=8
    const r6 = byId(events, 'r6');
    expect(r6?.outcome).toBe('miss'); // /a was evicted, so t=8 goes back to origin
    expect(r6?.detail?.cacheBytes).toBeLessThanOrEqual(700);
  });
});

describe('engine: logical clock, expiry and origin updates', () => {
  it('emits time advancement and origin update events on the shared clock', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    const advances = events.filter((e) => e.type === 'time_advanced');
    expect(advances.length).toBeGreaterThan(0);
    expect(advances[0].at).toBe(5);
    const updates = events.filter((e) => e.type === 'origin_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({url: '/a', version: 2, at: 50});
  });

  it('revalidates an expired entry with 304 when the origin version is unchanged', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    const r12 = byId(events, 'r12'); // /d expired at t=40, origin still v1
    expect(r12?.outcome).toBe('revalidated');
    expect(r12?.originBytes).toBe(REVALIDATE_BYTES);
    expect(r12?.clientBytes).toBe(200);
  });

  it('picks up the new origin version after it goes live', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    const r8 = byId(events, 'r8'); // /a expired at t=38; v2 live since t=50
    expect(r8?.outcome).toBe('miss');
    expect(r8?.version).toBe(2);
    expect(r8?.originBytes).toBe(480);
    expect(byId(events, 'r11')?.outcome).toBe('hit'); // fresh v2 afterwards
  });

  it('serves stale within the window instead of fetching', async () => {
    const {events} = await run(seedSnapshot(), stalePolicy);
    const r8 = byId(events, 'r8');
    expect(r8?.outcome).toBe('stale');
    expect(r8?.originBytes).toBe(0);
    expect(r8?.version).toBe(1); // still the old body
    const r11 = byId(events, 'r11'); // beyond the window -> forced back to origin, sees v2
    expect(r11?.outcome).toBe('miss');
    expect(r11?.version).toBe(2);
  });
});

describe('engine: uncacheable and non-GET traffic', () => {
  it('never stores objects larger than capacity', async () => {
    const {events} = await run(seedSnapshot(), basePolicy);
    const r9 = byId(events, 'r9');
    const r10 = byId(events, 'r10');
    expect(r9?.outcome).toBe('miss');
    expect(r9?.detail?.cached).toBe(false);
    expect(r10?.outcome).toBe('miss'); // fetched again: nothing was stored
    expect(r10?.originBytes).toBe(2000);
  });

  it('passes non-GET requests through without caching or coalescing', async () => {
    const snapshot: InputSnapshot = {
      origin: {'/x': [{version: 1, at: 0, headers: {'cache-control': 'max-age=100'}, body: 'x'.repeat(50)}]},
      requests: [
        {id: 'p1', at: 0, method: 'POST', url: '/x'},
        {id: 'p2', at: 0, method: 'POST', url: '/x'},
        {id: 'g1', at: 1, method: 'GET', url: '/x'},
      ],
    };
    const {events} = await run(snapshot, basePolicy);
    expect(byId(events, 'p1')?.outcome).toBe('bypass');
    expect(byId(events, 'p2')?.outcome).toBe('bypass');
    expect(byId(events, 'p2')?.originBytes).toBe(50);
    expect(byId(events, 'g1')?.outcome).toBe('miss'); // POSTs populated nothing
  });
});

describe('engine: one-sided failure and cancellation', () => {
  it('fails deterministically at the injected request id', async () => {
    const {result, events} = await run(seedSnapshot(), {...basePolicy, failAtRequestId: 'r6'});
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('policy_crashed');
    const failed = events.find((e) => e.type === 'run_failed');
    expect(failed?.detail?.requestId).toBe('r6');
    expect(byId(events, 'r6')).toBeUndefined(); // no event for the crashed request
    expect(byId(events, 'r5')).toBeDefined(); // earlier requests are intact
  });

  it('stops at the cancellation point and keeps partial events', async () => {
    const events: RunEvent[] = [];
    const state = {cancelled: false};
    const promise = executeRun(seedSnapshot(), basePolicy, 'A', {
      emit: (event) => {
        events.push({...event, seq: events.length + 1});
        if (events.filter((e) => e.type === 'request').length === 3) state.cancelled = true;
      },
      cancelled: () => state.cancelled,
      stepDelayMs: 0,
    });
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(events.some((e) => e.type === 'run_cancelled')).toBe(true);
    expect(events.some((e) => e.type === 'run_completed')).toBe(false);
    expect(requestsOf(events).length).toBe(3);
  });
});

describe('engine: determinism on the shared snapshot and clock', () => {
  it('produces identical event streams for identical inputs', async () => {
    const first = await run(seedSnapshot(), basePolicy);
    const second = await run(seedSnapshot(), basePolicy);
    expect(first.events).toEqual(second.events);
  });

  it('both policies observe the same origin versions at the same logical times', async () => {
    const a = await run(seedSnapshot(), basePolicy);
    const b = await run(seedSnapshot(), stalePolicy);
    const fetches = (events: RunEvent[]) =>
      new Map(
        requestsOf(events)
          .filter((e) => (e.originBytes ?? 0) > 0)
          .map((e) => [e.requestId ?? '', {at: e.at, version: e.version}]),
      );
    const fa = fetches(a.events);
    const fb = fetches(b.events);
    // For any request both sides took to origin, the observed version/time must match:
    // same immutable snapshot, same logical clock.
    let shared = 0;
    for (const [id, observation] of fa) {
      const other = fb.get(id);
      if (other) {
        shared += 1;
        expect(other).toEqual(observation);
      }
    }
    expect(shared).toBeGreaterThan(0);
    // The origin update at t=50 is visible to both sides, just at different requests.
    expect(fa.get('r8')).toEqual({at: 55, version: 2});
    expect(fb.get('r11')).toEqual({at: 70, version: 2});
  });
});
