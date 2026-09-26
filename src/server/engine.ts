import type {
  CachePolicy,
  OriginResource,
  OriginSnapshot,
  OriginVersion,
  ResourceUse,
  RunResult,
  Scenario,
  ScenarioEvent,
  ScenarioRequest,
  Side,
  SideRequestResult,
  SideTotals,
  Tick,
  TimelineEvent,
  UnpairedRow,
} from '../shared/types';
import {hashPolicy, hashSnapshot} from './hash';

// ---------------------------------------------------------------------------
// Origin replay line (shared immutable input for both sides)
// ---------------------------------------------------------------------------

export interface OriginLine {
  byUrl: Map<string, OriginResource>;
  /** ordered per-URL publish timeline: snapshot base versions + scenario publishes */
  publishes: Map<string, {tick: Tick; version: OriginVersion}[]>;
  /** per-side fault windows; url === undefined matches every resource */
  faults: Map<Side, {url?: string; start: Tick; end: Tick}[]>;
}

/**
 * Build the origin replay line for a run. Both sides evaluate against the SAME
 * line; the snapshot itself is never mutated (versions are cloned).
 */
export function buildOriginLine(snapshot: OriginSnapshot, events: ScenarioEvent[]): OriginLine {
  const byUrl = new Map<string, OriginResource>();
  const publishes = new Map<string, {tick: Tick; version: OriginVersion}[]>();
  for (const resource of snapshot.resources) {
    byUrl.set(resource.url, resource);
    publishes.set(
      resource.url,
      resource.versions.map((version) => ({tick: version.fromTick, version: {...version}})),
    );
  }

  for (const event of events) {
    if (event.type !== 'publish' || !event.url) continue;
    const list = publishes.get(event.url);
    if (!list) continue;
    const revision = event.revision ?? list[list.length - 1].version.revision + 1;
    list.push({
      tick: event.tick,
      version: {
        revision,
        fromTick: event.tick,
        bodyBytes: event.bodyBytes ?? list[list.length - 1].version.bodyBytes,
      },
    });
  }
  for (const list of publishes.values()) list.sort((x, y) => x.tick - y.tick);

  const faults = new Map<Side, {url?: string; start: Tick; end: Tick}[]>([
    ['a', []],
    ['b', []],
  ]);
  for (const event of events) {
    if (event.type !== 'fault') continue;
    const sides: Side[] = event.side ? [event.side] : ['a', 'b'];
    for (const side of sides) {
      faults.get(side)!.push({
        url: event.url,
        start: event.tick,
        end: event.tick + Math.max(1, event.duration ?? 1) - 1,
      });
    }
  }
  for (const list of faults.values()) list.sort((x, y) => x.start - y.start);
  return {byUrl, publishes, faults};
}

function versionAt(line: OriginLine, url: string, tick: Tick): OriginVersion | null {
  const list = line.publishes.get(url);
  if (!list) return null;
  let chosen: OriginVersion | null = null;
  for (const entry of list) {
    if (entry.tick <= tick) chosen = entry.version;
    else break;
  }
  return chosen;
}

function isFaulty(line: OriginLine, side: Side, url: string, tick: Tick): boolean {
  for (const window of line.faults.get(side) ?? []) {
    if (tick < window.start) break;
    if (tick <= window.end && (window.url === undefined || window.url === url)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-side deterministic simulation
// ---------------------------------------------------------------------------

interface CacheEntry {
  url: string;
  revision: number;
  bodyBytes: number;
  /** last refresh tick: 200 insertion or successful 304 */
  storedTick: Tick;
  /** LRU recency stamp (updated on every foreground use) */
  lruStamp: Tick;
}

type FetchMode = 'full' | 'cond';

interface Waiter {
  requestId: string;
  url: string;
  /** 'fg' produces a client reply; 'bg' is a SWR background revalidation */
  kind: 'fg' | 'bg';
  issuedTick: Tick;
}

interface Inflight {
  id: number;
  url: string;
  mode: FetchMode;
  startTick: Tick;
  readyTick: Tick;
  leaderId: string;
  waiters: Waiter[];
}

interface SideRuntime {
  side: Side;
  policy: CachePolicy;
  requestsById: Map<string, ScenarioRequest>;
  cache: Map<string, CacheEntry>;
  inflight: Inflight[];
  results: Map<string, SideRequestResult>;
  events: TimelineEvent[];
  warnings: string[];
  resource: ResourceUse;
  connected: boolean;
  shutdownTick: Tick | null;
  flightSeq: number;
}

export interface SideSimOutput {
  results: Map<string, SideRequestResult>;
  events: TimelineEvent[];
  resource: ResourceUse;
  connected: boolean;
  shutdownTick: Tick | null;
  failed: {message: string} | null;
  warnings: string[];
}

export interface SimInput {
  scenario: Scenario;
  line: OriginLine;
  policy: CachePolicy;
  side: Side;
  /** runtime-injected events (disconnect/reconnect/abort), replayed deterministically */
  injected: ScenarioEvent[];
  /** permanently cancel the side at this boundary tick */
  shutdownAt: Tick | null;
  /** logical horizon: simulate ticks [0, horizon] only */
  horizon: Tick | null;
}

export function simulateSide(input: SimInput): SideSimOutput {
  const rt: SideRuntime = {
    side: input.side,
    policy: input.policy,
    requestsById: new Map(input.scenario.requests.map((request) => [request.id, request])),
    cache: new Map(),
    inflight: [],
    results: new Map(),
    events: [],
    warnings: [],
    resource: {physicalFetches: 0, originBytes: 0, orphanOriginBytes: 0, evictions: 0},
    connected: true,
    shutdownTick: null,
    flightSeq: 0,
  };

  try {
    runTicks(rt, input);
  } catch (error) {
    // A side failure must never be mistaken for the other side's comparison.
    // Synthesize terminal errors for every request the side did not finish.
    const message = error instanceof Error ? error.message : String(error);
    rt.events.push({
      tick: input.horizon ?? 0,
      side: rt.side,
      type: 'side-failed',
      detail: message,
    });
    for (const request of input.scenario.requests) {
      if (!rt.results.has(request.id)) {
        rt.results.set(request.id, {
          requestId: request.id,
          side: rt.side,
          url: request.url,
          issuedTick: request.tick,
          completedTick: request.tick,
          outcome: 'error',
          servedFromCache: false,
          staleServed: false,
          coalesced: false,
          originBytes: 0,
          clientBytes: 0,
          status: 500,
          revision: null,
          note: `side failed: ${message}`,
        });
      }
    }
    return {
      results: rt.results,
      events: rt.events,
      resource: rt.resource,
      connected: rt.connected,
      shutdownTick: null,
      failed: {message},
      warnings: rt.warnings,
    };
  }

  return {
    results: rt.results,
    events: rt.events,
    resource: rt.resource,
    connected: rt.connected,
    shutdownTick: rt.shutdownTick,
    failed: null,
    warnings: rt.warnings,
  };
}

function runTicks(rt: SideRuntime, input: SimInput) {
  const {scenario, line} = input;
  const events = [...scenario.events, ...input.injected].filter(
    (event) => !event.side || event.side === rt.side,
  );
  const eventsByTick = new Map<Tick, ScenarioEvent[]>();
  for (const event of events) {
    const list = eventsByTick.get(event.tick) ?? [];
    list.push(event);
    eventsByTick.set(event.tick, list);
  }
  for (const list of eventsByTick.values()) list.sort(compareEvents);

  const requestsByTick = new Map<Tick, ScenarioRequest[]>();
  for (const request of scenario.requests) {
    const list = requestsByTick.get(request.tick) ?? [];
    list.push(request);
    requestsByTick.set(request.tick, list);
  }

  const maxTick =
    input.horizon ?? computeMaxTick(scenario, events, line);

  for (let tick = 0; tick <= maxTick; tick++) {
    // 1) side shutdown boundary precedes everything else
    if (input.shutdownAt !== null && tick === input.shutdownAt) {
      shutdown(rt, tick, 'side cancelled by user');
      return;
    }
    // 2) scripted / injected control events
    for (const event of eventsByTick.get(tick) ?? []) applyEvent(rt, event, tick);
    if (rt.shutdownTick !== null) return;
    // 3) requests issued at this tick
    for (const request of requestsByTick.get(tick) ?? []) issue(rt, line, request, tick);
    // 4) fetches ready at this tick
    for (const flight of rt.inflight.filter((f) => f.readyTick === tick).sort(byStart)) {
      complete(rt, line, flight, tick);
    }
  }

  if (input.shutdownAt !== null && input.shutdownAt > maxTick) {
    shutdown(rt, input.shutdownAt, 'side cancelled after horizon');
  }
}

function byStart(a: Inflight, b: Inflight) {
  return a.startTick - b.startTick || a.id - b.id;
}

const EVENT_ORDER: ScenarioEvent['type'][] = [
  'publish',
  'fault',
  'disconnect',
  'reconnect',
  'abort',
];
function compareEvents(a: ScenarioEvent, b: ScenarioEvent) {
  return EVENT_ORDER.indexOf(a.type) - EVENT_ORDER.indexOf(b.type);
}

function computeMaxTick(scenario: Scenario, events: ScenarioEvent[], line: OriginLine): Tick {
  const maxLatency = Math.max(1, ...[...line.byUrl.values()].map((r) => r.latency));
  let max = 0;
  for (const request of scenario.requests) max = Math.max(max, request.tick + maxLatency + 1);
  for (const event of events) {
    max = Math.max(max, event.tick + 1);
    if (event.type === 'fault') max = Math.max(max, event.tick + (event.duration ?? 1));
  }
  return max;
}

// ---------------------------------------------------------------------------
// control events
// ---------------------------------------------------------------------------

function applyEvent(rt: SideRuntime, event: ScenarioEvent, tick: Tick) {
  switch (event.type) {
    case 'publish':
      rt.events.push({tick, side: 'both', type: 'publish', url: event.url});
      return;
    case 'fault':
      rt.events.push({tick, side: rt.side, type: 'fault', url: event.url});
      return;
    case 'disconnect':
      if (rt.connected) {
        rt.connected = false;
        rt.events.push({tick, side: rt.side, type: 'disconnect'});
      }
      return;
    case 'reconnect':
      if (!rt.connected) {
        rt.connected = true;
        rt.events.push({tick, side: rt.side, type: 'reconnect'});
      }
      return;
    case 'abort':
      abortRequest(rt, event, tick);
      return;
  }
}

function abortRequest(rt: SideRuntime, event: ScenarioEvent, tick: Tick) {
  const id = event.requestId;
  if (!id) return;
  rt.events.push({tick, side: rt.side, type: 'abort', requestId: id});
  const request = rt.requestsById.get(id);
  const finished = rt.results.get(id);
  if (finished) {
    rt.warnings.push(
      `t${tick} abort of ${id} ignored: already ${finished.outcome} at t${finished.completedTick}`,
    );
    return;
  }
  for (const flight of rt.inflight) {
    const index = flight.waiters.findIndex((w) => w.requestId === id && w.kind === 'fg');
    if (index < 0) continue;
    flight.waiters.splice(index, 1);
    if (flight.leaderId === id) {
      const next = flight.waiters.find((w) => w.kind === 'fg');
      if (next) flight.leaderId = next.requestId;
    }
    if (flight.waiters.length === 0) {
      // nobody is waiting anymore: the cache layer drops the fetch
      const idx = rt.inflight.indexOf(flight);
      rt.inflight.splice(idx, 1);
    }
    setCancelled(rt, id, tick, 'aborted while origin fetch in flight');
    return;
  }
  // not issued yet (or instant-cached path already terminal, handled above)
  setCancelled(rt, id, tick, request ? 'aborted before scheduled issue' : 'aborted: unknown request');
}

function setCancelled(rt: SideRuntime, id: string, tick: Tick, note: string) {
  const request = rt.requestsById.get(id);
  rt.results.set(id, {
    requestId: id,
    side: rt.side,
    url: request?.url ?? '',
    issuedTick: request?.tick ?? tick,
    completedTick: null,
    outcome: 'cancelled',
    servedFromCache: false,
    staleServed: false,
    coalesced: false,
    originBytes: 0,
    clientBytes: 0,
    status: 'cancelled',
    revision: null,
    note,
  });
}

function shutdown(rt: SideRuntime, tick: Tick, reason: string) {
  rt.shutdownTick = tick;
  rt.events.push({tick, side: rt.side, type: 'cancel-side', detail: reason});
  const pending = [...new Set(rt.inflight.flatMap((f) => f.waiters.filter((w) => w.kind === 'fg').map((w) => w.requestId)))];
  for (const id of pending) setCancelled(rt, id, tick, 'side shut down mid-fetch');
  rt.inflight = [];
  for (const request of rt.requestsById.values()) {
    if (!rt.results.has(request.id)) {
      setCancelled(rt, request.id, tick, 'side shut down before request was served');
    }
  }
}

// ---------------------------------------------------------------------------
// request issue / cache decision
// ---------------------------------------------------------------------------

function issue(rt: SideRuntime, line: OriginLine, request: ScenarioRequest, tick: Tick) {
  if (rt.results.has(request.id)) return; // aborted ahead of its issue tick
  rt.events.push({tick, side: rt.side, type: 'request', requestId: request.id, url: request.url});
  const settle = (
    completedTick: Tick,
    fields: Omit<SideRequestResult, 'requestId' | 'side' | 'url' | 'issuedTick' | 'completedTick'>,
  ): SideRequestResult => ({
    requestId: request.id,
    side: rt.side,
    url: request.url,
    issuedTick: tick,
    completedTick,
    ...fields,
  });

  const entry = rt.cache.get(request.url);
  if (entry) {
    const age = tick - entry.storedTick;
    if (age <= rt.policy.maxAge) {
      entry.lruStamp = tick;
      rt.results.set(request.id, settle(tick, {
        outcome: 'hit',
        servedFromCache: true,
        staleServed: false,
        coalesced: false,
        originBytes: 0,
        clientBytes: 0,
        status: 200,
        revision: entry.revision,
      }));
      rt.events.push({tick, side: rt.side, type: 'hit', requestId: request.id, url: request.url});
      return;
    }
    const staleFor = age - rt.policy.maxAge;
    if (staleFor <= rt.policy.staleWhileRevalidate) {
      entry.lruStamp = tick;
      rt.results.set(request.id, settle(tick, {
        outcome: 'stale',
        servedFromCache: true,
        staleServed: true,
        coalesced: false,
        originBytes: 0,
        clientBytes: 0,
        status: 200,
        revision: entry.revision,
        note: 'stale-while-revalidate: served cached body, background revalidation started',
      }));
      rt.events.push({tick, side: rt.side, type: 'stale:swr', requestId: request.id, url: request.url});
      startFetch(rt, line, {requestId: request.id, url: request.url, kind: 'bg', issuedTick: tick}, tick);
      return;
    }
    // expired beyond SWR window -> client waits on a conditional revalidation
    if (!rt.connected) {
      failOffline(rt, {requestId: request.id, url: request.url, kind: 'fg', issuedTick: tick}, tick);
      return;
    }
    startFetch(rt, line, {requestId: request.id, url: request.url, kind: 'fg', issuedTick: tick}, tick);
    return;
  }
  if (!rt.connected) {
    failOffline(rt, {requestId: request.id, url: request.url, kind: 'fg', issuedTick: tick}, tick);
    return;
  }
  startFetch(rt, line, {requestId: request.id, url: request.url, kind: 'fg', issuedTick: tick}, tick);
}

/** Client is offline at issue time: fetch never goes out; apply stale-if-error. */
function failOffline(rt: SideRuntime, waiter: Waiter, tick: Tick) {
  rt.events.push({
    tick,
    side: rt.side,
    type: 'origin:error',
    requestId: waiter.requestId,
    url: waiter.url,
    detail: 'offline at issue time',
  });
  const entry = rt.cache.get(waiter.url);
  const age = entry ? tick - entry.storedTick : Infinity;
  const staleFor = entry ? age - rt.policy.maxAge : Infinity;
  if (entry && staleFor <= rt.policy.staleIfError) {
    entry.lruStamp = tick;
    finish(rt, waiter, tick, {
      outcome: 'stale',
      servedFromCache: true,
      staleServed: true,
      coalesced: false,
      originBytes: 0,
      clientBytes: 0,
      status: 200,
      revision: entry.revision,
      note: 'stale-if-error fallback (offline at issue time)',
    }, 'stale:error');
    return;
  }
  finish(rt, waiter, tick, {
    outcome: 'error',
    servedFromCache: false,
    staleServed: false,
    coalesced: false,
    originBytes: 0,
    clientBytes: 0,
    status: 500,
    revision: null,
    note: 'offline at issue time; no stale-if-error fallback',
  }, 'origin:error');
}

/**
 * Start an origin fetch or merge into a compatible in-flight one.
 *
 * Coalescing compatibility (the shared wire answer must satisfy every joiner):
 *  - 'cond' revalidators MAY join a 'full' fetch: a full GET always returns
 *    200 with a body, which replaces the stale entry and satisfies the joiner;
 *  - 'full' missers MUST NOT join a 'cond' fetch: a 304 ships no body and a
 *    cold client would have nothing to serve.
 */
function startFetch(rt: SideRuntime, line: OriginLine, waiter: Waiter, tick: Tick) {
  const hasEntry = rt.cache.has(waiter.url);
  const mode: FetchMode = hasEntry ? 'cond' : 'full';

  if (rt.policy.coalesce) {
    const joinable = rt.inflight.find((flight) => {
      if (flight.url !== waiter.url) return false;
      if (flight.mode === mode) return true;
      return mode === 'cond' && flight.mode === 'full';
    });
    if (joinable) {
      joinable.waiters.push(waiter);
      rt.events.push({
        tick,
        side: rt.side,
        type: 'coalesce:join',
        requestId: waiter.requestId,
        url: waiter.url,
        detail: `joined ${joinable.mode} fetch led by ${joinable.leaderId}`,
      });
      return;
    }
  }

  const latency = Math.max(1, line.byUrl.get(waiter.url)?.latency ?? 1);
  const flight: Inflight = {
    id: rt.flightSeq++,
    url: waiter.url,
    mode,
    startTick: tick,
    readyTick: tick + latency,
    leaderId: waiter.requestId,
    waiters: [waiter],
  };
  rt.inflight.push(flight);
  rt.resource.physicalFetches += 1;
  rt.events.push({
    tick,
    side: rt.side,
    type: 'origin:start',
    requestId: waiter.requestId,
    url: waiter.url,
    detail: `${mode} GET (${waiter.kind})`,
  });
}

// ---------------------------------------------------------------------------
// fetch completion
// ---------------------------------------------------------------------------

function complete(rt: SideRuntime, line: OriginLine, flight: Inflight, tick: Tick) {
  const index = rt.inflight.indexOf(flight);
  if (index >= 0) rt.inflight.splice(index, 1);

  const {url} = flight;
  const fg = flight.waiters.filter((w) => w.kind === 'fg');
  const bgCount = flight.waiters.length - fg.length;
  const failed = isFaulty(line, rt.side, url, tick) || !rt.connected;

  if (failed) {
    const why = !rt.connected ? 'client disconnected' : 'origin 500 fault window';
    rt.events.push({tick, side: rt.side, type: 'origin:error', url, requestId: flight.leaderId, detail: why});
    // background revalidation errors are swallowed (client already got stale)
    void bgCount;
    for (const waiter of fg) failForeground(rt, line, flight, waiter, tick, why);
    return;
  }

  const version = versionAt(line, url, tick);
  if (!version) {
    for (const waiter of fg) {
      finish(rt, waiter, tick, {
        outcome: 'error',
        servedFromCache: false,
        staleServed: false,
        coalesced: waiter.requestId !== flight.leaderId,
        originBytes: 0,
        clientBytes: 0,
        status: 500,
        revision: null,
        note: 'origin serves no version for this url',
      }, 'origin:error');
    }
    return;
  }

  const entry = rt.cache.get(url);
  const notModified = flight.mode === 'cond' && entry?.revision === version.revision;

  if (notModified) {
    rt.events.push({tick, side: rt.side, type: 'origin:304', url, requestId: flight.leaderId});
    entry!.storedTick = tick;
    entry!.lruStamp = tick;
    for (const waiter of fg) {
      finish(rt, waiter, tick, {
        outcome: 'revalidated',
        servedFromCache: true,
        staleServed: false,
        coalesced: waiter.requestId !== flight.leaderId,
        originBytes: 0,
        clientBytes: 0,
        status: 200,
        revision: entry!.revision,
      }, 'complete');
    }
    return;
  }

  // 200: body crosses the wire once; the leader owns the byte accounting
  rt.events.push({
    tick,
    side: rt.side,
    type: 'origin:200',
    url,
    requestId: flight.leaderId,
    detail: `rev ${version.revision}, ${version.bodyBytes}B`,
  });
  storeEntry(rt, url, version, tick);
  rt.resource.originBytes += version.bodyBytes;
  if (fg.length === 0) rt.resource.orphanOriginBytes += version.bodyBytes;

  for (const waiter of fg) {
    const leader = waiter.requestId === flight.leaderId;
    finish(rt, waiter, tick, {
      outcome: 'miss',
      servedFromCache: false,
      staleServed: false,
      coalesced: waiter.requestId !== flight.leaderId,
      originBytes: leader ? version.bodyBytes : 0,
      clientBytes: leader ? version.bodyBytes : 0,
      status: 200,
      revision: version.revision,
    }, 'complete');
  }
}

function failForeground(
  rt: SideRuntime,
  _line: OriginLine,
  flight: Inflight,
  waiter: Waiter,
  tick: Tick,
  why: string,
) {
  const entry = rt.cache.get(flight.url);
  const age = entry ? tick - entry.storedTick : Infinity;
  const staleFor = entry ? age - rt.policy.maxAge : Infinity;
  if (entry && staleFor <= rt.policy.staleIfError) {
    entry.lruStamp = tick;
    finish(rt, waiter, tick, {
      outcome: 'stale',
      servedFromCache: true,
      staleServed: true,
      coalesced: waiter.requestId !== flight.leaderId,
      originBytes: 0,
      clientBytes: 0,
      status: 200,
      revision: entry.revision,
      note: `stale-if-error fallback (${why})`,
    }, 'stale:error');
    return;
  }
  finish(rt, waiter, tick, {
    outcome: 'error',
    servedFromCache: false,
    staleServed: false,
    coalesced: waiter.requestId !== flight.leaderId,
    originBytes: 0,
    clientBytes: 0,
    status: 500,
    revision: null,
    note: `${why}; no stale-if-error fallback`,
  }, 'origin:error');
}

function finish(
  rt: SideRuntime,
  waiter: Waiter,
  tick: Tick,
  fields: Omit<SideRequestResult, 'requestId' | 'side' | 'url' | 'issuedTick' | 'completedTick'>,
  eventType: TimelineEvent['type'],
) {
  rt.results.set(waiter.requestId, {
    requestId: waiter.requestId,
    side: rt.side,
    url: waiter.url,
    issuedTick: waiter.issuedTick,
    completedTick: tick,
    ...fields,
  });
  rt.events.push({tick, side: rt.side, type: eventType, requestId: waiter.requestId, url: waiter.url});
}

function storeEntry(rt: SideRuntime, url: string, version: OriginVersion, tick: Tick) {
  const existing = rt.cache.get(url);
  if (existing) {
    existing.revision = version.revision;
    existing.bodyBytes = version.bodyBytes;
    existing.storedTick = tick;
    existing.lruStamp = tick;
    return;
  }
  if (rt.cache.size >= rt.policy.capacity) evictLRU(rt, tick);
  if (rt.cache.size >= rt.policy.capacity) {
    rt.warnings.push(`t${tick} could not cache ${url}: capacity ${rt.policy.capacity} saturated by busy entries`);
    return;
  }
  rt.cache.set(url, {
    url,
    revision: version.revision,
    bodyBytes: version.bodyBytes,
    storedTick: tick,
    lruStamp: tick,
  });
}

function evictLRU(rt: SideRuntime, tick: Tick) {
  const busyUrls = new Set(rt.inflight.map((flight) => flight.url));
  let victimKey: string | null = null;
  let victimStamp = Infinity;
  for (const [key, entry] of rt.cache) {
    if (busyUrls.has(key)) continue;
    if (entry.lruStamp < victimStamp) {
      victimStamp = entry.lruStamp;
      victimKey = key;
    }
  }
  if (!victimKey) {
    rt.warnings.push(`t${tick} eviction required but every entry has an in-flight revalidation`);
    return;
  }
  const victim = rt.cache.get(victimKey)!;
  rt.cache.delete(victimKey);
  rt.resource.evictions += 1;
  rt.events.push({
    tick,
    side: rt.side,
    type: 'evict',
    url: victimKey,
    detail: `LRU evict rev ${victim.revision} (last used t${victim.lruStamp})`,
  });
}

// ---------------------------------------------------------------------------
// pairing + summary (denominator = terminal on BOTH sides)
// ---------------------------------------------------------------------------

export function buildSummary(
  scenario: Scenario,
  a: SideSimOutput,
  b: SideSimOutput,
): {pairs: RunResult['pairs']; unpaired: UnpairedRow[]; summary: RunResult['summary']} {
  const pairs: RunResult['pairs'] = [];
  const unpaired: UnpairedRow[] = [];
  for (const request of scenario.requests) {
    const ra = a.results.get(request.id);
    const rb = b.results.get(request.id);
    // a hard side failure invalidates pairing even if terminal results were synthesized
    if (!a.failed && !b.failed && isPairedTerminal(ra) && isPairedTerminal(rb)) {
      pairs.push({requestId: request.id, url: request.url, tick: request.tick, a: ra!, b: rb!});
    } else {
      unpaired.push({
        requestId: request.id,
        url: request.url,
        tick: request.tick,
        reason: unpairedReason(ra, rb, a, b),
        a: ra,
        b: rb,
      });
    }
  }
  const totalsA = totalsFor(pairs.map((pair) => pair.a));
  const totalsB = totalsFor(pairs.map((pair) => pair.b));
  return {
    pairs,
    unpaired,
    summary: {
      paired: pairs.length,
      unpaired,
      totalsA,
      totalsB,
      metrics: pairMetrics(totalsA, totalsB),
      resources: {a: a.resource, b: b.resource},
    },
  };
}

function isPairedTerminal(result: SideRequestResult | undefined): boolean {
  return Boolean(result && result.completedTick !== null && result.outcome !== 'cancelled');
}

function unpairedReason(
  ra: SideRequestResult | undefined,
  rb: SideRequestResult | undefined,
  a: SideSimOutput,
  b: SideSimOutput,
): UnpairedRow['reason'] {
  if (a.failed) return 'a_failed';
  if (b.failed) return 'b_failed';
  if (a.shutdownTick !== null && b.shutdownTick !== null) return 'side_a_cancelled';
  if (a.shutdownTick !== null) return 'side_a_cancelled';
  if (b.shutdownTick !== null) return 'side_b_cancelled';
  if (!ra && !rb) return 'a_pending';
  if (!ra) return 'a_pending';
  if (!rb) return 'b_pending';
  if (ra.outcome === 'cancelled' && rb.outcome === 'cancelled') return 'both_cancelled';
  if (ra.outcome === 'cancelled') return 'a_cancelled';
  if (rb.outcome === 'cancelled') return 'b_cancelled';
  return 'b_missing';
}

function totalsFor(results: SideRequestResult[]): SideTotals {
  const totals: SideTotals = {
    requests: results.length,
    hits: 0,
    revalidated: 0,
    misses: 0,
    stale: 0,
    errors: 0,
    cancelled: 0,
    coalesced: 0,
    originBytes: 0,
    clientBytes: 0,
  };
  for (const r of results) {
    if (r.outcome === 'hit') totals.hits += 1;
    if (r.outcome === 'revalidated') totals.revalidated += 1;
    if (r.outcome === 'miss') totals.misses += 1;
    if (r.outcome === 'stale') totals.stale += 1;
    if (r.outcome === 'error') totals.errors += 1;
    if (r.coalesced) totals.coalesced += 1;
    totals.originBytes += r.originBytes;
    totals.clientBytes += r.clientBytes;
  }
  return totals;
}

function pairMetrics(a: SideTotals, b: SideTotals) {
  const metric = (x: number, y: number) => ({a: x, b: y, delta: y - x});
  return {
    hits: metric(a.hits, b.hits),
    revalidated: metric(a.revalidated, b.revalidated),
    misses: metric(a.misses, b.misses),
    stale: metric(a.stale, b.stale),
    errors: metric(a.errors, b.errors),
    coalesced: metric(a.coalesced, b.coalesced),
    originBytes: metric(a.originBytes, b.originBytes),
    clientBytes: metric(a.clientBytes, b.clientBytes),
  };
}

// ---------------------------------------------------------------------------
// full run assembly
// ---------------------------------------------------------------------------

export interface RunConfig {
  runId: string;
  scenario: Scenario;
  snapshot: OriginSnapshot;
  policyA: CachePolicy;
  policyB: CachePolicy;
  injectedA?: ScenarioEvent[];
  injectedB?: ScenarioEvent[];
  shutdownAtA?: Tick | null;
  shutdownAtB?: Tick | null;
  horizon?: Tick | null;
  createdAt?: string;
}

export function runBoth(config: RunConfig): RunResult {
  const line = buildOriginLine(config.snapshot, config.scenario.events);
  const outA = simulateSide({
    scenario: config.scenario,
    line,
    policy: config.policyA,
    side: 'a',
    injected: config.injectedA ?? [],
    shutdownAt: config.shutdownAtA ?? null,
    horizon: config.horizon ?? null,
  });
  const outB = simulateSide({
    scenario: config.scenario,
    line,
    policy: config.policyB,
    side: 'b',
    injected: config.injectedB ?? [],
    shutdownAt: config.shutdownAtB ?? null,
    horizon: config.horizon ?? null,
  });
  const {pairs, unpaired, summary} = buildSummary(config.scenario, outA, outB);

  const sideResults: RunResult['sideResults'] = {};
  for (const [id, r] of outA.results) sideResults[`a:${id}`] = r;
  for (const [id, r] of outB.results) sideResults[`b:${id}`] = r;

  const horizon = config.horizon ?? null;
  const cancelled = outA.shutdownTick !== null || outB.shutdownTick !== null;
  const failed = outA.failed || outB.failed;
  const events = mergeTimeline(outA.events, outB.events);
  const warnings = dedupe([...outA.warnings.map((w) => `[A] ${w}`), ...outB.warnings.map((w) => `[B] ${w}`)]);
  const lastTick = events.length ? events[events.length - 1].tick : horizon;
  const terminal = cancelled || failed || horizon === null;

  return {
    runId: config.runId,
    scenarioId: config.scenario.id,
    snapshotId: config.snapshot.id,
    policyHashA: hashPolicy(config.policyA),
    policyHashB: hashPolicy(config.policyB),
    policyA: config.policyA,
    policyB: config.policyB,
    status: failed ? 'failed' : cancelled ? 'cancelled' : horizon === null ? 'complete' : 'running',
    startTick: 0,
    clockTick: horizon ?? lastTick,
    endTick: terminal ? lastTick : null,
    cancelSide: outA.shutdownTick !== null ? 'a' : outB.shutdownTick !== null ? 'b' : undefined,
    cancelTick: outA.shutdownTick ?? outB.shutdownTick ?? undefined,
    errorSide: outA.failed ? 'a' : outB.failed ? 'b' : undefined,
    error: outA.failed?.message ?? outB.failed?.message,
    pairs,
    unpaired,
    sideResults,
    events,
    warnings,
    summary,
    resourcesA: outA.resource,
    resourcesB: outB.resource,
    createdAt: config.createdAt ?? new Date().toISOString(),
    finishedAt: terminal ? new Date().toISOString() : null,
  };
}

export function snapshotHash(snapshot: OriginSnapshot): string {
  return hashSnapshot({id: snapshot.id, resources: snapshot.resources});
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeTimeline(a: TimelineEvent[], b: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const merged: TimelineEvent[] = [];
  for (const event of [...a, ...b]) {
    const key = `${event.tick}|${event.side}|${event.type}|${event.requestId ?? ''}|${event.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  merged.sort((x, y) => x.tick - y.tick || String(x.side).localeCompare(String(y.side)));
  return merged;
}

export function validatePolicy(policy: CachePolicy): string | null {
  if (!policy.name?.trim()) return 'policy name is required';
  if (!Number.isInteger(policy.maxAge) || policy.maxAge < 0) return 'maxAge must be a non-negative integer';
  if (!Number.isInteger(policy.staleWhileRevalidate) || policy.staleWhileRevalidate < 0)
    return 'staleWhileRevalidate must be a non-negative integer';
  if (!Number.isInteger(policy.staleIfError) || policy.staleIfError < 0)
    return 'staleIfError must be a non-negative integer';
  if (!Number.isInteger(policy.capacity) || policy.capacity < 1)
    return 'capacity must be a positive integer';
  return null;
}
