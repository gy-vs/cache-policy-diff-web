import type {CachePolicy, OriginSnapshot, Scenario} from '../shared/types';

/**
 * Immutable origin input snapshot for the lab.
 * Two resources with differing sizes/latencies; versions are keyed by tick.
 */
export const seedSnapshot: OriginSnapshot = {
  id: 'snap-seed-1',
  name: 'Seed snapshot: two resources',
  createdAt: '2026-01-01T00:00:00.000Z',
  resources: [
    {
      url: '/api/experiments/alpha',
      latency: 3,
      versions: [
        {revision: 1, fromTick: 0, bodyBytes: 1200},
        {revision: 2, fromTick: 20, bodyBytes: 1280},
      ],
    },
    {
      url: '/api/experiments/beta',
      latency: 2,
      versions: [{revision: 1, fromTick: 0, bodyBytes: 500}],
    },
    {
      url: '/api/config',
      latency: 4,
      versions: [{revision: 1, fromTick: 0, bodyBytes: 300}],
    },
    {
      // cold until the abort case, so its fetch is in-flight on BOTH sides
      url: '/api/heavy',
      latency: 5,
      versions: [{revision: 1, fromTick: 0, bodyBytes: 3000}],
    },
  ],
};

/**
 * Fixed request sequence exercising:
 *  - concurrent requests to the same URL (coalescing)
 *  - time advancement across freshness boundaries
 *  - origin publish (response update)
 *  - fault window + stale-if-error
 *  - disconnect / reconnect
 *  - abort of an in-flight request
 *  - capacity pressure (LRU eviction)
 */
export const seedScenario: Scenario = {
  id: 'scenario-seed-1',
  name: 'Seed sequence: coalesce, evict, faults, reconnect',
  snapshotId: seedSnapshot.id,
  requests: [
    // cold misses on both sides
    {id: 'r01', url: '/api/experiments/alpha', tick: 1},
    // concurrent duplicates right behind the cold fetch -> coalesce candidates
    {id: 'r02', url: '/api/experiments/alpha', tick: 2},
    {id: 'r03', url: '/api/experiments/alpha', tick: 2},
    // other resources
    {id: 'r04', url: '/api/experiments/beta', tick: 3},
    {id: 'r05', url: '/api/config', tick: 4},
    // fresh repeat -> hit while within maxAge on both
    {id: 'r06', url: '/api/experiments/alpha', tick: 5},
    // after origin publishes rev 2 at t20
    {id: 'r07', url: '/api/experiments/alpha', tick: 22},
    {id: 'r08', url: '/api/experiments/beta', tick: 22},
    // fault window on alpha covering the whole revalidation (t30..33)
    {id: 'r09', url: '/api/experiments/alpha', tick: 30},
    // cold heavy fetch aborted while in flight on both sides (ready at t45)
    {id: 'r10', url: '/api/heavy', tick: 40},
    // disconnect t50-55, request issued during outage
    {id: 'r11', url: '/api/experiments/beta', tick: 51},
    // after reconnect, retry
    {id: 'r12', url: '/api/experiments/beta', tick: 58},
    // capacity pressure: rotate through all four resources (B has capacity 2)
    {id: 'r13', url: '/api/heavy', tick: 70},
    {id: 'r14', url: '/api/config', tick: 71},
    {id: 'r15', url: '/api/experiments/alpha', tick: 72},
    // late repeats
    {id: 'r16', url: '/api/experiments/alpha', tick: 90},
    {id: 'r17', url: '/api/experiments/beta', tick: 91},
  ],
  events: [
    {type: 'publish', tick: 20, url: '/api/experiments/alpha', revision: 2, bodyBytes: 1280},
    // origin returns 500 for alpha across ticks 30..33 on both sides
    {type: 'fault', tick: 30, url: '/api/experiments/alpha', duration: 4},
    // abort r10 while its fetch is in flight
    {type: 'abort', tick: 42, requestId: 'r10'},
    // transport outage ticks 50..54 on both sides
    {type: 'disconnect', tick: 50},
    {type: 'reconnect', tick: 55},
  ],
};

export const policyAggressive: CachePolicy = {
  name: 'A: long TTL + SWR + coalesce',
  maxAge: 10,
  staleWhileRevalidate: 30,
  staleIfError: 40,
  coalesce: true,
  capacity: 3,
};

export const policyConservative: CachePolicy = {
  name: 'B: short TTL, no stale, no coalesce',
  maxAge: 2,
  staleWhileRevalidate: 0,
  staleIfError: 0,
  coalesce: false,
  capacity: 2,
};

export const seedPolicies: CachePolicy[] = [policyAggressive, policyConservative];
