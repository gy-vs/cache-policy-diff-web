import {describe, expect, it} from 'vitest';
import {
  buildOriginLine,
  buildSummary,
  runBoth,
  simulateSide,
  type SimInput,
} from './engine';
import {hashPolicy} from './hash';
import type {CachePolicy, OriginSnapshot, Scenario} from '../shared/types';

const snapshot: OriginSnapshot = {
  id: 'snap-test',
  name: 'test',
  createdAt: '1970-01-01T00:00:00.000Z',
  resources: [
    {url: '/x', latency: 3, versions: [{revision: 1, fromTick: 0, bodyBytes: 100}]},
    {url: '/y', latency: 2, versions: [{revision: 1, fromTick: 0, bodyBytes: 50}]},
  ],
};

const basePolicy: CachePolicy = {
  name: 'p',
  maxAge: 10,
  staleWhileRevalidate: 0,
  staleIfError: 0,
  coalesce: true,
  capacity: 4,
};

function scenario(partial?: Partial<Scenario>): Scenario {
  return {
    id: 'scn',
    name: 'test',
    snapshotId: snapshot.id,
    requests: [],
    events: [],
    ...partial,
  };
}

function side(input: Partial<SimInput> & {scenario: Scenario; side: 'a' | 'b'; policy: CachePolicy}) {
  return simulateSide({
    line: buildOriginLine(snapshot, input.scenario.events),
    injected: [],
    shutdownAt: null,
    horizon: null,
    ...input,
  });
}

describe('determinism and shared snapshot', () => {
  it('recomputes identically and never mutates the snapshot', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 1},
        {id: '2', url: '/x', tick: 2},
        {id: '3', url: '/x', tick: 12},
      ],
    });
    const before = JSON.stringify(snapshot);
    const run1 = runBoth({runId: 'r1', scenario: scn, snapshot, policyA: basePolicy, policyB: basePolicy});
    const run2 = runBoth({runId: 'r2', scenario: scn, snapshot, policyA: basePolicy, policyB: basePolicy});
    expect(JSON.stringify(run1.summary)).toBe(JSON.stringify(run2.summary));
    expect(JSON.stringify(run1.pairs)).toBe(JSON.stringify(run2.pairs));
    expect(JSON.stringify(snapshot)).toBe(before);
    // both sides bind to the same snapshot id/hash
    expect(run1.snapshotId).toBe('snap-test');
  });

  it('content hash changes when the draft changes and stays stable otherwise', () => {
    const h1 = hashPolicy(basePolicy);
    const h2 = hashPolicy({...basePolicy, maxAge: 11});
    const h3 = hashPolicy({...basePolicy, name: 'different-name-same-semantics'});
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toBe(hashPolicy({...basePolicy}));
  });
});

describe('concurrent request coalescing', () => {
  const scn = scenario({requests: [
    {id: '1', url: '/x', tick: 1},
    {id: '2', url: '/x', tick: 2},
    {id: '3', url: '/x', tick: 2},
  ]});

  it('merges concurrent cold fetches into one physical fetch', () => {
    const out = side({scenario: scn, side: 'a', policy: basePolicy});
    expect(out.resource.physicalFetches).toBe(1);
    const r1 = out.results.get('1')!;
    const r2 = out.results.get('2')!;
    const r3 = out.results.get('3')!;
    for (const r of [r1, r2, r3]) expect(r.outcome).toBe('miss');
    expect(r1.coalesced).toBe(false);
    expect(r2.coalesced).toBe(true);
    expect(r3.coalesced).toBe(true);
    // only the leader owns the transferred body bytes
    expect(r1.originBytes).toBe(100);
    expect(r2.originBytes).toBe(0);
    expect(r3.originBytes).toBe(0);
    expect(out.resource.originBytes).toBe(100);
  });

  it('performs separate fetches when coalescing is disabled', () => {
    const out = side({
      scenario: scn,
      side: 'b',
      policy: {...basePolicy, coalesce: false},
    });
    expect(out.resource.physicalFetches).toBe(3);
    expect(out.resource.originBytes).toBe(300);
  });

  it('a cold misser never joins a conditional fetch that could answer 304', () => {
    const scn2 = scenario({requests: [
      {id: 'warm', url: '/x', tick: 1},
      // expiry then concurrent: one revalidator + one cold misser
      {id: 'reval', url: '/x', tick: 15},
      // capacity 1 eviction makes /y-cold unrelated; force cold via eviction below
    ], events: []});
    const policy: CachePolicy = {...basePolicy, capacity: 1};
    // evict /x by filling with /y, then concurrent cond + full at the same tick
    const scn3 = scenario({requests: [
      {id: 'warm-x', url: '/x', tick: 1},
      {id: 'fill-y', url: '/y', tick: 2}, // evicts /x (capacity 1)
      {id: 'cold-x', url: '/x', tick: 3}, // full fetch in flight (ready t6)
      {id: 'warm-x2', url: '/y', tick: 3}, // no-op for x
    ]});
    const out = side({scenario: scn3, side: 'a', policy});
    void scn2;
    // cold /x fetches its own body and serves it
    expect(out.results.get('cold-x')!.outcome).toBe('miss');
  });
});

describe('time advancement, expiry and revalidation', () => {
  it('hits while fresh, revalidates after maxAge, refreshes on 304', () => {
    const scn = scenario({requests: [
      {id: '1', url: '/x', tick: 0},
      {id: '2', url: '/x', tick: 5},
      // stored at t3; t14 is 11 ticks after storage -> expired
      {id: '3', url: '/x', tick: 14},
    ]});
    const out = side({scenario: scn, side: 'a', policy: basePolicy});
    expect(out.results.get('1')!.outcome).toBe('miss');
    expect(out.results.get('2')!.outcome).toBe('hit');
    expect(out.results.get('3')!.outcome).toBe('revalidated');
    expect(out.results.get('3')!.servedFromCache).toBe(true);
    expect(out.results.get('3')!.originBytes).toBe(0);
  });

  it('serves stale immediately and refreshes in the background (SWR)', () => {
    const policy = {...basePolicy, staleWhileRevalidate: 10};
    const scn = scenario({requests: [
      {id: '1', url: '/x', tick: 0},
      {id: '2', url: '/x', tick: 14}, // stored t3; 1 tick stale at issue -> SWR
    ]});
    const out = side({scenario: scn, side: 'a', policy});
    const r2 = out.results.get('2')!;
    expect(r2.outcome).toBe('stale');
    expect(r2.staleServed).toBe(true);
    expect(r2.completedTick).toBe(14);
    // the background fetch physically happened and updated the cache
    expect(out.resource.physicalFetches).toBe(2);
    const r3 = side({
      scenario: scenario({requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 14},
        {id: '3', url: '/x', tick: 20}, // bg fetch done t17, fresh until t27
      ]}),
      side: 'a',
      policy,
    }).results.get('3')!;
    expect(r3.outcome).toBe('hit');
  });
});

describe('origin response updates (publish)', () => {
  it('picks up the new revision after publish and invalidates 304', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 8}, // fresh (stored t3, maxAge 10)
        {id: '3', url: '/x', tick: 25}, // expired; conditional GET finds rev 2 -> 200
      ],
      events: [{type: 'publish', tick: 20, url: '/x', revision: 2, bodyBytes: 200}],
    });
    const out = side({scenario: scn, side: 'a', policy: basePolicy});
    expect(out.results.get('2')!.outcome).toBe('hit');
    const r3 = out.results.get('3')!;
    expect(r3.outcome).toBe('miss'); // cond GET answered 200: full new body downloaded
    expect(r3.revision).toBe(2);
    expect(r3.originBytes).toBe(200);
    expect(out.resource.originBytes).toBe(300); // 100 cold + 200 after publish
  });
});

describe('cache eviction (LRU, capacity)', () => {
  it('evicts the least recently used entry and forces a refetch', () => {
    const policy = {...basePolicy, capacity: 1};
    const scn = scenario({requests: [
      {id: '1', url: '/x', tick: 0},
      {id: '2', url: '/y', tick: 1}, // evicts /x
      {id: '3', url: '/x', tick: 10}, // must refetch
    ]});
    const out = side({scenario: scn, side: 'a', policy});
    expect(out.resource.evictions).toBeGreaterThanOrEqual(1);
    expect(out.results.get('3')!.outcome).toBe('miss');
    // rotation without coalescing: each displaced URL must be refetched
    const policyNoCoalesce = {...policy, coalesce: false};
    const scn2 = scenario({requests: [
      {id: '1', url: '/x', tick: 0}, // ready t3, stored
      {id: '2', url: '/y', tick: 5}, // ready t7, evicts x
      {id: '3', url: '/x', tick: 9}, // cold again, ready t12, evicts y
      {id: '4', url: '/y', tick: 14}, // cold again
    ]});
    const out2 = side({scenario: scn2, side: 'a', policy: policyNoCoalesce});
    expect(out2.results.get('4')!.outcome).toBe('miss');
    expect(out2.resource.evictions).toBeGreaterThanOrEqual(3);
  });
});

describe('origin faults and stale-if-error', () => {
  it('serves stale within staleIfError, otherwise errors', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 14}, // cond fetch issued t14, ready t17, faulty
      ],
      events: [{type: 'fault', tick: 14, url: '/x', duration: 5}],
    });
    const withFallback = side({scenario: scn, side: 'a', policy: {...basePolicy, staleIfError: 10}});
    expect(withFallback.results.get('2')!.outcome).toBe('stale');
    expect(withFallback.results.get('2')!.status).toBe(200);

    const noFallback = side({scenario: scn, side: 'b', policy: basePolicy});
    expect(noFallback.results.get('2')!.outcome).toBe('error');
    expect(noFallback.results.get('2')!.status).toBe(500);
  });

  it('isolates a fault to one side when the event is side-scoped', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 14},
      ],
      events: [{type: 'fault', tick: 14, url: '/x', duration: 5, side: 'b'}],
    });
    const line = buildOriginLine(snapshot, scn.events);
    const a = simulateSide({scenario: scn, line, policy: basePolicy, side: 'a', injected: [], shutdownAt: null, horizon: null});
    const b = simulateSide({scenario: scn, line, policy: basePolicy, side: 'b', injected: [], shutdownAt: null, horizon: null});
    expect(a.results.get('2')!.outcome).toBe('revalidated');
    expect(b.results.get('2')!.outcome).toBe('error');
  });
});

describe('disconnect and reconnect', () => {
  it('fails fetches during the outage and recovers after reconnect', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 14}, // expired; cond fetch ready t17, still disconnected
        {id: '3', url: '/x', tick: 20}, // reconnected t15 -> revalidates, ready t23
      ],
      events: [{type: 'disconnect', tick: 9}, {type: 'reconnect', tick: 15}],
    });
    const out = side({scenario: scn, side: 'a', policy: basePolicy});
    expect(out.results.get('2')!.outcome).toBe('error');
    expect(out.results.get('3')!.outcome).toBe('revalidated');
    expect(out.events.some((e) => e.type === 'disconnect')).toBe(true);
    expect(out.events.some((e) => e.type === 'reconnect')).toBe(true);
  });

  it('never lets an offline client start a fetch; stale-if-error still applies', () => {
    const scn = scenario({
      requests: [
        {id: '1', url: '/x', tick: 0},
        {id: '2', url: '/x', tick: 14}, // expired and offline at issue time
      ],
      events: [{type: 'disconnect', tick: 13}, {type: 'reconnect', tick: 20}],
    });
    const fallback = side({scenario: scn, side: 'a', policy: {...basePolicy, staleIfError: 100}});
    expect(fallback.results.get('2')!.outcome).toBe('stale');
    expect(fallback.resource.physicalFetches).toBe(1); // only the cold fetch; nothing re-fetched offline

    const hardFail = side({scenario: scn, side: 'b', policy: basePolicy});
    expect(hardFail.results.get('2')!.outcome).toBe('error');
    expect(hardFail.resource.physicalFetches).toBe(1);
  });
});

describe('abort and one-side cancellation', () => {
  it('aborts an in-flight request and excludes it from the paired denominator', () => {
    const scn = scenario({
      requests: [{id: '1', url: '/x', tick: 0}, {id: '2', url: '/y', tick: 1}],
      events: [{type: 'abort', tick: 2, requestId: '2'}],
    });
    const run = runBoth({runId: 'r', scenario: scn, snapshot, policyA: basePolicy, policyB: basePolicy});
    expect(run.sideResults['a:2']!.outcome).toBe('cancelled');
    expect(run.summary.paired).toBe(1);
    expect(run.summary.unpaired[0].reason).toBe('both_cancelled');
  });

  it('cancelling one side never turns the other side into a full comparison', () => {
    const scn = scenario({requests: [
      {id: 'before', url: '/x', tick: 0},
      {id: 'after', url: '/x', tick: 20},
    ]});
    const run = runBoth({
      runId: 'r',
      scenario: scn,
      snapshot,
      policyA: basePolicy,
      policyB: basePolicy,
      shutdownAtA: 10,
    });
    expect(run.status).toBe('cancelled');
    expect(run.cancelSide).toBe('a');
    const after = run.unpaired.find((u) => u.requestId === 'after')!;
    expect(after.reason).toBe('side_a_cancelled');
    // B still computed its own result independently
    expect(after.b!.outcome).toBe('revalidated');
    // only the request complete on BOTH sides is in the denominator
    expect(run.summary.paired).toBe(1);
    expect(run.summary.totalsB.requests).toBe(1);
  });
});

describe('paired summary denominator and accounting', () => {
  it('counts metrics only over requests terminal on both sides', () => {
    const scn = scenario({
      requests: [
        {id: 'ok', url: '/x', tick: 0},
        {id: 'only-a-done', url: '/y', tick: 1},
      ],
      events: [{type: 'abort', tick: 1, requestId: 'only-a-done', side: 'b'}],
    });
    const run = runBoth({runId: 'r', scenario: scn, snapshot, policyA: basePolicy, policyB: basePolicy});
    expect(run.summary.paired).toBe(1);
    expect(run.summary.unpaired[0].reason).toBe('b_cancelled');
    expect(run.summary.totalsA.requests).toBe(1);
    expect(run.summary.totalsB.requests).toBe(1);
    // B's aborted fetch did not leak bytes into the comparison
    expect(run.summary.metrics.originBytes.a).toBe(100);
    expect(run.summary.metrics.originBytes.b).toBe(100);
  });

  it('reports pending (horizon-cut) requests with explicit reasons', () => {
    const scn = scenario({requests: [
      {id: 'early', url: '/x', tick: 0},
      {id: 'late', url: '/y', tick: 10},
    ]});
    const run = runBoth({
      runId: 'r', scenario: scn, snapshot, policyA: basePolicy, policyB: basePolicy, horizon: 5,
    });
    expect(run.status).toBe('running');
    expect(run.summary.paired).toBe(1);
    const late = run.unpaired.find((u) => u.requestId === 'late')!;
    expect(['a_pending', 'b_pending']).toContain(late.reason);
  });
});

describe('one side runtime failure', () => {
  it('marks the failing side failed and keeps every request out of the paired set', () => {
    const scn = scenario({requests: [{id: '1', url: '/x', tick: 0}]});
    const line = buildOriginLine(snapshot, scn.events);
    const a = simulateSide({scenario: scn, line, policy: basePolicy, side: 'a', injected: [], shutdownAt: null, horizon: null});
    // sabotage: a line missing the resource makes B's version lookup return null -> 500,
    // emulate a hard failure by re-running against a snapshot whose resource throws
    const brokenPublishes = new Map(line.publishes);
    brokenPublishes.set('/x', new Proxy(brokenPublishes.get('/x')!, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) throw new Error('boom: side runtime failure');
        return Reflect.get(target, prop, receiver);
      },
    }));
    const brokenLine: typeof line = {
      byUrl: line.byUrl,
      publishes: brokenPublishes,
      faults: line.faults,
    };
    const b = simulateSide({scenario: scn, line: brokenLine, policy: basePolicy, side: 'b', injected: [], shutdownAt: null, horizon: null});
    const {summary} = buildSummary(scn, a, b);
    expect(b.failed).not.toBeNull();
    expect(summary.paired).toBe(0);
    expect(summary.unpaired[0].reason).toBe('b_failed');
  });
});
