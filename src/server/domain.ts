import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';

export type Side = 'A' | 'B';
export const SIDES: Side[] = ['A', 'B'];

export interface OriginVersion {
  version: number;
  at: number; // logical seconds: this version is live from `at`
  status?: number; // 200 by default; >=500 simulates an origin error
  headers: Record<string, string>;
  body: string;
}

export interface RequestSpec {
  id: string; // original request id; events on both sides align on it
  at: number; // logical send time in seconds (non-decreasing across the sequence)
  method: string;
  url: string;
}

export interface InputSnapshot {
  requests: RequestSpec[];
  origin: Record<string, OriginVersion[]>; // url -> versions, ascending by `at`
}

export interface PolicyConfig {
  capacityBytes: number;
  defaultTtlSeconds: number;
  respectOriginHeaders: boolean;
  serveStale: boolean;
  staleWindowSeconds: number;
  coalesceConcurrent: boolean;
  conditionalRevalidate: boolean;
  failAtRequestId?: string; // deterministic fault injection for the lab
}

export type Outcome =
  | 'hit'
  | 'miss'
  | 'revalidated'
  | 'stale'
  | 'coalesced'
  | 'bypass'
  | 'error';

export type RunEventType =
  | 'run_started'
  | 'run_completed'
  | 'run_cancelled'
  | 'run_failed'
  | 'time_advanced'
  | 'origin_updated'
  | 'evict'
  | 'request';

export interface RunEvent {
  seq: number;
  type: RunEventType;
  at?: number;
  requestId?: string;
  url?: string;
  outcome?: Outcome;
  status?: number;
  version?: number;
  originBytes?: number;
  clientBytes?: number;
  sizeBytes?: number;
  reason?: string;
  detail?: Record<string, unknown>;
}

export class LabError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- hashing: drafts bind to exact text, snapshots bind to canonical JSON ---

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export const hashJson = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

export const hashText = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

// --- validation ---

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSnapshot(raw: unknown): InputSnapshot {
  if (!isObject(raw)) throw new LabError(422, 'invalid_snapshot', 'snapshot must be an object');
  const reqRaw = raw.requests;
  const originRaw = raw.origin;
  if (!Array.isArray(reqRaw)) throw new LabError(422, 'invalid_snapshot', 'requests must be an array');
  if (!isObject(originRaw)) throw new LabError(422, 'invalid_snapshot', 'origin must be an object');

  const origin: InputSnapshot['origin'] = {};
  for (const [url, versionsRaw] of Object.entries(originRaw)) {
    if (!Array.isArray(versionsRaw) || versionsRaw.length === 0)
      throw new LabError(422, 'invalid_snapshot', `origin ${url} needs >=1 version`);
    let prevAt = -1;
    let prevVersion = 0;
    origin[url] = versionsRaw.map((vRaw) => {
      if (!isObject(vRaw)) throw new LabError(422, 'invalid_snapshot', `${url} version must be an object`);
      const at = Number(vRaw.at);
      const version = Number(vRaw.version);
      if (!Number.isFinite(at) || at < 0) throw new LabError(422, 'invalid_snapshot', `${url} version has bad at`);
      if (!Number.isInteger(version) || version <= prevVersion)
        throw new LabError(422, 'invalid_snapshot', `${url} versions must have increasing integer versions`);
      if (at < prevAt) throw new LabError(422, 'invalid_snapshot', `${url} versions must be ordered by at`);
      prevAt = at;
      prevVersion = version;
      const headers: Record<string, string> = {};
      if (vRaw.headers !== undefined) {
        if (!isObject(vRaw.headers)) throw new LabError(422, 'invalid_snapshot', `${url} headers must be an object`);
        for (const [k, v] of Object.entries(vRaw.headers)) headers[k.toLowerCase()] = String(v);
      }
      return {
        version,
        at,
        status: vRaw.status === undefined ? undefined : Number(vRaw.status),
        headers,
        body: String(vRaw.body ?? ''),
      };
    });
  }

  const seen = new Set<string>();
  let lastAt = -1;
  const requests: RequestSpec[] = reqRaw.map((rRaw) => {
    if (!isObject(rRaw)) throw new LabError(422, 'invalid_snapshot', 'request must be an object');
    const id = String(rRaw.id ?? '');
    const at = Number(rRaw.at);
    const method = String(rRaw.method ?? 'GET').toUpperCase();
    const url = String(rRaw.url ?? '');
    if (!id) throw new LabError(422, 'invalid_snapshot', 'request id required');
    if (seen.has(id)) throw new LabError(422, 'invalid_snapshot', `duplicate request id ${id}`);
    seen.add(id);
    if (!Number.isFinite(at) || at < 0) throw new LabError(422, 'invalid_snapshot', `${id}: bad at`);
    if (at < lastAt) throw new LabError(422, 'invalid_snapshot', `${id}: at must be non-decreasing`);
    lastAt = at;
    if (!url.startsWith('/')) throw new LabError(422, 'invalid_snapshot', `${id}: url must start with /`);
    const versions = origin[url];
    if (!versions) throw new LabError(422, 'invalid_snapshot', `${id}: origin for ${url} missing`);
    if (versions[0].at > at)
      throw new LabError(422, 'invalid_snapshot', `${id}: no origin version live at t=${at} for ${url}`);
    return {id, at, method, url};
  });

  return {requests, origin};
}

export function parsePolicy(text: string): PolicyConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LabError(422, 'policy_invalid', 'draft is not valid JSON');
  }
  if (!isObject(raw)) throw new LabError(422, 'policy_invalid', 'draft must be a JSON object');
  const integer = (key: string, fallback: number, min = 0): number => {
    const v = raw[key] === undefined ? fallback : Number(raw[key]);
    if (!Number.isInteger(v) || v < min) throw new LabError(422, 'policy_invalid', `${key} must be an integer >= ${min}`);
    return v;
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const v = raw[key] === undefined ? fallback : raw[key];
    if (typeof v !== 'boolean') throw new LabError(422, 'policy_invalid', `${key} must be boolean`);
    return v;
  };
  const failAtRequestIdRaw = raw.failAtRequestId;
  if (failAtRequestIdRaw !== undefined && typeof failAtRequestIdRaw !== 'string')
    throw new LabError(422, 'policy_invalid', 'failAtRequestId must be a string');
  return {
    capacityBytes: integer('capacityBytes', 1 << 20),
    defaultTtlSeconds: integer('defaultTtlSeconds', 0),
    respectOriginHeaders: boolean('respectOriginHeaders', true),
    serveStale: boolean('serveStale', false),
    staleWindowSeconds: integer('staleWindowSeconds', 0),
    coalesceConcurrent: boolean('coalesceConcurrent', true),
    conditionalRevalidate: boolean('conditionalRevalidate', false),
    failAtRequestId: failAtRequestIdRaw,
  };
}

// --- fixed lab scenario: coalescing, eviction, expiry, origin update, stale ---

const fill = (ch: string, bytes: number) => ch.repeat(bytes);

export function seedSnapshot(): InputSnapshot {
  const cc = 'max-age=30';
  return {
    origin: {
      '/a': [
        {version: 1, at: 0, headers: {'cache-control': cc, etag: '"a1"'}, body: fill('a', 400)},
        {version: 2, at: 50, headers: {'cache-control': cc, etag: '"a2"'}, body: fill('A', 480)},
      ],
      '/b': [{version: 1, at: 0, headers: {'cache-control': cc, etag: '"b1"'}, body: fill('b', 300)}],
      '/c': [{version: 1, at: 0, headers: {'cache-control': cc, etag: '"c1"'}, body: fill('c', 300)}],
      // /d sends no cache-control: defaultTtlSeconds applies
      '/d': [{version: 1, at: 0, headers: {etag: '"d1"'}, body: fill('d', 200)}],
      // /big exceeds every policy capacity: fetched but never stored
      '/big': [{version: 1, at: 0, headers: {'cache-control': cc}, body: fill('x', 2000)}],
    },
    requests: [
      {id: 'r1', at: 0, method: 'GET', url: '/a'},
      {id: 'r2', at: 0, method: 'GET', url: '/a'}, // concurrent with r1/r3
      {id: 'r3', at: 0, method: 'GET', url: '/a'},
      {id: 'r4', at: 5, method: 'GET', url: '/b'},
      {id: 'r5', at: 6, method: 'GET', url: '/c'}, // evicts /a (700B LRU)
      {id: 'r6', at: 8, method: 'GET', url: '/a'}, // miss again: /a was evicted
      {id: 'r7', at: 20, method: 'GET', url: '/d'},
      {id: 'r8', at: 55, method: 'GET', url: '/a'}, // /a expired at 38; v2 live at 50
      {id: 'r9', at: 65, method: 'GET', url: '/big'},
      {id: 'r10', at: 66, method: 'GET', url: '/big'},
      {id: 'r11', at: 70, method: 'GET', url: '/a'},
      {id: 'r12', at: 70, method: 'GET', url: '/d'},
    ],
  };
}

export function seedDrafts(): Record<Side, string> {
  const base = {
    capacityBytes: 700,
    defaultTtlSeconds: 20,
    respectOriginHeaders: true,
  };
  return {
    // A: collapse concurrent misses, revalidate expired entries conditionally
    A: JSON.stringify(
      {...base, serveStale: false, staleWindowSeconds: 0, coalesceConcurrent: true, conditionalRevalidate: true},
      null,
      2,
    ),
    // B: every concurrent miss goes to origin, prefer stale-serving within a window
    B: JSON.stringify(
      {...base, serveStale: true, staleWindowSeconds: 30, coalesceConcurrent: false, conditionalRevalidate: false},
      null,
      2,
    ),
  };
}
