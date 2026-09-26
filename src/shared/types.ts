// Shared protocol types for the HTTP cache strategy workbench.
// Everything is plain JSON so client and server share one contract.

/** Logical clock: discrete tick. One tick ~ one unit of wall time. */
export type Tick = number;

export type Side = 'a' | 'b';

/**
 * An immutable origin response snapshot. Both strategy sides replay against
 * the *same* snapshot; a simulation never mutates it.
 */
export interface OriginVersion {
  /** Revision, also used as the ETag. */
  revision: number;
  /** Tick from which the origin serves this version (versions are ordered). */
  fromTick: Tick;
  bodyBytes: number;
}

export interface OriginResource {
  url: string;
  /** Ordered versions; the latest one with fromTick <= now is served. */
  versions: OriginVersion[];
  /** Origin latency in ticks for any fetch of this resource. */
  latency: Tick;
}

export interface OriginSnapshot {
  id: string;
  name: string;
  createdAt: string;
  resources: OriginResource[];
}

/** Declarative cache policy draft. Bound to results by content hash. */
export interface CachePolicy {
  name: string;
  maxAge: Tick;
  /** Allow serving stale while triggering a background revalidation (RFC 5861). */
  staleWhileRevalidate: Tick;
  /** Serve stale on origin error (RFC 5861). */
  staleIfError: Tick;
  /** Merge concurrent in-flight requests for the same URL. */
  coalesce: boolean;
  /** Max cached entries; LRU eviction beyond this size. */
  capacity: number;
}

export type ScenarioEventType =
  | 'publish'
  | 'fault'
  | 'disconnect'
  | 'reconnect'
  | 'abort';

export interface ScenarioEvent {
  type: ScenarioEventType;
  tick: Tick;
  /** publish / fault / disconnect / reconnect: target URL ('fault' only). */
  url?: string;
  /** Per-side events: which side ('a' | 'b'); applies to both if omitted. */
  side?: Side;
  /** fault: window length in ticks (default 1). */
  duration?: Tick;
  /** publish: new revision / size produced at the origin. */
  revision?: number;
  bodyBytes?: number;
  /** abort: request id to cancel. */
  requestId?: string;
}

export interface ScenarioRequest {
  id: string;
  url: string;
  tick: Tick;
}

export interface Scenario {
  id: string;
  name: string;
  snapshotId: string;
  requests: ScenarioRequest[];
  events: ScenarioEvent[];
}

/**
 * Per-request outcome on one side.
 * hit         — cache fresh, no origin contact
 * revalidated — conditional GET returned 304, body came from cache
 * miss        — full fetch (200)
 * stale       — an expired stored response was served (SWR / stale-if-error)
 * error       — client saw a failure and no stale fallback existed
 * cancelled   — abort (or side shutdown) stopped the request before completion
 */
export type Outcome =
  | 'hit'
  | 'revalidated'
  | 'miss'
  | 'stale'
  | 'error'
  | 'cancelled';

export interface SideRequestResult {
  requestId: string;
  side: Side;
  url: string;
  issuedTick: Tick;
  /** Tick the client got a terminal answer; null while pending. */
  completedTick: Tick | null;
  outcome: Outcome;
  /** Body came from a stored response (hit / 304 / stale). */
  servedFromCache: boolean;
  /** Served an expired stored response (stale-while-revalidate / stale-if-error). */
  staleServed: boolean;
  /** Joined another in-flight origin request via coalescing. */
  coalesced: boolean;
  /** Body bytes physically transferred from the origin for THIS request (leader only). */
  originBytes: number;
  /** Body bytes delivered to the client over the network (0 for cache-served). */
  clientBytes: number;
  /** Status the client observed. */
  status: 200 | 500 | 'cancelled';
  /** Revision served to the client, when a body was produced. */
  revision: number | null;
  note?: string;
}

export type TimelineEventType =
  | 'request'
  | 'hit'
  | 'origin:start'
  | 'origin:304'
  | 'origin:200'
  | 'origin:error'
  | 'stale:swr'
  | 'stale:error'
  | 'evict'
  | 'coalesce:join'
  | 'disconnect'
  | 'reconnect'
  | 'publish'
  | 'fault'
  | 'abort'
  | 'cancel-side'
  | 'side-failed'
  | 'complete'
  | 'warn';

export interface TimelineEvent {
  tick: Tick;
  side: Side | 'both';
  type: TimelineEventType;
  requestId?: string;
  url?: string;
  detail?: string;
  /** Injected at runtime via the control API rather than the fixed scenario. */
  injected?: boolean;
}

/** Per-request counters over a slice of requests. */
export interface SideTotals {
  /** Denominator this row was computed over. */
  requests: number;
  hits: number;
  revalidated: number;
  misses: number;
  stale: number;
  errors: number;
  cancelled: number;
  coalesced: number;
  /** Foreground-attributable bytes (leader of a coalesced batch owns them). */
  originBytes: number;
  clientBytes: number;
}

/** Side-wide physical resource usage over the whole run (incl. background work). */
export interface ResourceUse {
  /** Origin connections (a coalesced batch counts once; SWR fetches included). */
  physicalFetches: number;
  /** All bytes off the origin (200 bodies), including background revalidations. */
  originBytes: number;
  /** Origin bytes from background revalidations not attributable to a foreground reply. */
  orphanOriginBytes: number;
  evictions: number;
}

export interface PairMetric {
  a: number;
  b: number;
  /** b - a. */
  delta: number;
}

export interface PairRow {
  requestId: string;
  url: string;
  tick: Tick;
  a: SideRequestResult;
  b: SideRequestResult;
}

export type UnpairedReason =
  | 'a_missing'
  | 'b_missing'
  | 'a_cancelled'
  | 'b_cancelled'
  | 'both_cancelled'
  | 'a_pending'
  | 'b_pending'
  | 'a_failed'
  | 'b_failed'
  | 'side_a_cancelled'
  | 'side_b_cancelled';

export interface UnpairedRow {
  requestId: string;
  url: string;
  tick: Tick;
  reason: UnpairedReason;
  a?: SideRequestResult;
  b?: SideRequestResult;
}

export interface RunSummary {
  /**
   * Denominator: requests with a terminal, non-cancelled result on BOTH sides.
   * All per-request counters below cover exactly this paired slice.
   */
  paired: number;
  /** Requests excluded from the denominator and why. */
  unpaired: UnpairedRow[];
  totalsA: SideTotals;
  totalsB: SideTotals;
  metrics: {
    hits: PairMetric;
    revalidated: PairMetric;
    misses: PairMetric;
    stale: PairMetric;
    errors: PairMetric;
    coalesced: PairMetric;
    originBytes: PairMetric;
    clientBytes: PairMetric;
  };
  /** Whole-run physical resource usage (NOT restricted to the paired slice). */
  resources: {a: ResourceUse; b: ResourceUse};
}

export type RunStatus = 'running' | 'complete' | 'cancelled' | 'failed';

export interface RunResult {
  runId: string;
  scenarioId: string;
  snapshotId: string;
  /** Content hashes the run was computed with. */
  policyHashA: string;
  policyHashB: string;
  /** Full policy snapshots as bound to this run (immutable record). */
  policyA: CachePolicy;
  policyB: CachePolicy;
  status: RunStatus;
  startTick: Tick;
  /** Current / final logical clock value. */
  clockTick: Tick | null;
  endTick: Tick | null;
  cancelSide?: Side;
  cancelTick?: Tick;
  errorSide?: Side;
  error?: string;
  pairs: PairRow[];
  unpaired: UnpairedRow[];
  /** Keyed `${side}:${requestId}` */
  sideResults: Record<string, SideRequestResult>;
  events: TimelineEvent[];
  warnings: string[];
  summary: RunSummary;
  resourcesA: ResourceUse;
  resourcesB: ResourceUse;
  createdAt: string;
  finishedAt: string | null;
}

/** Stored policy draft: content is immutable per hash. */
export interface StoredPolicy {
  hash: string;
  policy: CachePolicy;
  createdAt: string;
}

export interface Bootstrap {
  family: string;
  snapshots: {id: string; name: string; hash: string}[];
  scenarios: {id: string; name: string; snapshotId: string}[];
  policies: StoredPolicy[];
  runs: {runId: string; scenarioId: string; status: RunStatus; createdAt: string}[];
}

export interface ApiError {
  error: string;
  detail?: string;
}
