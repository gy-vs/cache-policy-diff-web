import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import {LabStore} from '../src/server/store';
import {seedSnapshot} from '../src/server/domain';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createApp(new LabStore()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => null);
  return {status: response.status, body};
};

const post = (path: string, body: unknown) =>
  api(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

const put = (path: string, body: unknown) =>
  api(path, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

async function waitForState(id: string, side: 'A' | 'B', states: string[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const {body} = await api(`/api/experiments/${id}`);
    const state = body.runs?.[side]?.state;
    if (state && states.includes(state)) return body.runs[side];
    if (Date.now() > deadline) throw new Error(`run ${side} did not reach ${states} (now ${state})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const runBoth = async (id: string, stepDelayMs = 0) => {
  const started = await post(`/api/experiments/${id}/runs`, {sides: ['A', 'B'], stepDelayMs});
  expect(started.status).toBe(202);
  await waitForState(id, 'A', ['completed', 'failed', 'cancelled']);
  await waitForState(id, 'B', ['completed', 'failed', 'cancelled']);
};

// Minimal SSE client for reconnect tests.
function openSse(path: string, lastEventId?: number) {
  const events: {id: number; event: string; data: string}[] = [];
  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => (doneResolve = resolve));
  const headers: Record<string, string> = {accept: 'text/event-stream'};
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const request = http.get(`${base}${path}`, {headers}, (response) => {
    let buffer = '';
    response.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const record: {id?: number; event?: string; data?: string} = {};
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) record.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) record.event = line.slice(7);
          else if (line.startsWith('data: ')) record.data = line.slice(6);
        }
        if (record.id !== undefined && record.event && record.data !== undefined) {
          events.push({id: record.id, event: record.event, data: record.data});
          if (['run_completed', 'run_cancelled', 'run_failed'].includes(record.event)) doneResolve();
        }
      }
    });
    response.on('end', () => doneResolve());
  });
  return {events, done, close: () => request.destroy()};
}

describe('immutable snapshot and content-hash binding', () => {
  it('exposes a stable snapshot hash and binds drafts by content hash', async () => {
    const first = await api('/api/experiments/lab');
    const second = await api('/api/experiments/lab');
    expect(first.status).toBe(200);
    expect(first.body.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.snapshotHash).toBe(second.body.snapshotHash);
    expect(first.body.drafts.A.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.drafts.A.hash).not.toBe(first.body.drafts.B.hash);
    expect(first.body.snapshot.requests.length).toBeGreaterThan(0);
  });

  it('rejects invalid snapshots and duplicate request ids', async () => {
    const snapshot = seedSnapshot();
    const bad = await post('/api/experiments', {
      snapshot: {...snapshot, requests: [snapshot.requests[0], snapshot.requests[0]]},
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('invalid_snapshot');
  });
});

describe('paired comparison over the fixed sequence', () => {
  it('runs both sides on the same snapshot and summarizes only paired requests', async () => {
    await runBoth('lab');
    const {status, body} = await api('/api/experiments/lab/summary');
    expect(status).toBe(200);
    expect(body.comparisonComplete).toBe(true);
    expect(body.paired).toBe(body.totalRequests);
    expect(body.unpaired).toEqual([]);
    expect(body.runStates).toEqual({A: 'completed', B: 'completed'});
    // Same immutable input on both sides:
    expect(body.runPolicyHashes.A).toBe(body.policyHashes.A);
    // Policies differ: B does not coalesce and serves stale, so it pulls more origin bytes.
    expect(body.totals.B.coalesced).toBe(0);
    expect(body.totals.A.coalesced).toBeGreaterThan(0);
    expect(body.totals.B.stale).toBeGreaterThan(0);
    expect(body.totals.A.stale).toBe(0);
    expect(body.totals.originBytesDelta).toBeGreaterThan(0);
    // Rows align on the original request id, in sequence order.
    expect(body.rows.map((row: {requestId: string}) => row.requestId)).toEqual(
      (await api('/api/experiments/lab')).body.snapshot.requests.map((r: {id: string}) => r.id),
    );
  });

  it('marks old results stale after a draft edit but keeps them', async () => {
    const before = await api('/api/experiments/lab/summary');
    expect(before.body.stale).toEqual({A: false, B: false});
    const edited = JSON.parse((await api('/api/experiments/lab')).body.drafts.A.text);
    edited.defaultTtlSeconds = 5;
    const saved = await put('/api/experiments/lab/drafts/A', {text: JSON.stringify(edited, null, 2)});
    expect(saved.status).toBe(200);
    expect(saved.body.staleMarked).toBe(true);

    const after = await api('/api/experiments/lab/summary');
    expect(after.body.stale.A).toBe(true);
    expect(after.body.stale.B).toBe(false);
    // Old run results are still there, paired and countable.
    expect(after.body.paired).toBe(after.body.totalRequests);
    expect(after.body.runPolicyHashes.A).not.toBe(after.body.policyHashes.A);

    // Restore the original draft for later tests.
    const original = await post('/api/experiments', {snapshot: seedSnapshot()});
    expect(original.status).toBe(201);
    await put('/api/experiments/lab/drafts/A', {text: original.body.drafts.A.text});
    const restored = await api('/api/experiments/lab/summary');
    expect(restored.body.stale.A).toBe(false);
  });
});

describe('one-sided failure', () => {
  it('excludes requests after the crash and reports the reason', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    const draftB = JSON.parse(created.body.drafts.B.text);
    draftB.failAtRequestId = 'r6';
    await put(`/api/experiments/${id}/drafts/B`, {text: JSON.stringify(draftB)});
    await runBoth(id);

    const {body} = await api(`/api/experiments/${id}/summary`);
    expect(body.runStates).toEqual({A: 'completed', B: 'failed'});
    expect(body.comparisonComplete).toBe(false);
    expect(body.paired).toBe(5); // r1..r5 finished on both sides
    expect(body.totalRequests).toBe(12);
    const unpairedIds = body.unpaired.map((u: {requestId: string}) => u.requestId);
    expect(unpairedIds).toEqual(['r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12']);
    for (const item of body.unpaired) {
      expect(item.missing).toEqual(['B']);
      expect(item.reasons.B).toBe('failed');
    }
    // Totals only count the paired denominator.
    expect(body.totals.A.requests).toBe(5);
    expect(body.totals.B.requests).toBe(5);
  });

  it('rejects an unparsable draft instead of running it', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    await put(`/api/experiments/${id}/drafts/A`, {text: '{not json'});
    const started = await post(`/api/experiments/${id}/runs`, {sides: ['A']});
    expect(started.status).toBe(422);
    expect(started.body.error).toBe('policy_invalid');
  });
});

describe('cancellation keeps the other side from being a full control', () => {
  it('cancelling B mid-run leaves A complete but the comparison incomplete', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    const started = await post(`/api/experiments/${id}/runs`, {sides: ['A', 'B'], stepDelayMs: 30});
    expect(started.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 60)); // let B process a few requests
    const cancel = await post(`/api/experiments/${id}/runs/B/cancel`, {});
    expect(cancel.status).toBe(200);
    await waitForState(id, 'B', ['cancelled']);
    await waitForState(id, 'A', ['completed']);

    const {body} = await api(`/api/experiments/${id}/summary`);
    expect(body.runStates).toEqual({A: 'completed', B: 'cancelled'});
    expect(body.comparisonComplete).toBe(false);
    expect(body.paired).toBeGreaterThan(0);
    expect(body.paired).toBeLessThan(body.totalRequests);
    for (const item of body.unpaired) {
      expect(item.missing).toEqual(['B']);
      expect(item.reasons.B).toBe('cancelled');
    }
    // A finished everything, but totals are still computed over the paired subset only.
    expect(body.totals.A.requests).toBe(body.paired);
  });

  it('refuses to cancel a run that is not running', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    await runBoth(id);
    const cancel = await post(`/api/experiments/${id}/runs/A/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe('not_running');
  });
});

describe('disconnect and reconnect', () => {
  it('polling with after= resumes without loss or duplication', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    await post(`/api/experiments/${id}/runs`, {sides: ['A'], stepDelayMs: 15});
    const first = await api(`/api/experiments/${id}/runs/A/events?after=0`);
    expect(first.body.events.length).toBeGreaterThan(0);
    await waitForState(id, 'A', ['completed']);
    const resumed = await api(`/api/experiments/${id}/runs/A/events?after=${first.body.latestSeq}`);
    const all = [...first.body.events, ...resumed.body.events];
    const seqs = all.map((e: {seq: number}) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(seqs).toEqual([...Array(seqs.length).keys()].map((i) => i + 1)); // no gaps
    expect(all.some((e: {type: string}) => e.type === 'run_completed')).toBe(true);
  });

  it('SSE reconnect with Last-Event-ID resumes the stream exactly once per event', async () => {
    const created = await post('/api/experiments', {snapshot: seedSnapshot()});
    const id = created.body.id;
    await post(`/api/experiments/${id}/runs`, {sides: ['A'], stepDelayMs: 12});

    const first = openSse(`/api/experiments/${id}/runs/A/events/stream`);
    const deadline = Date.now() + 3000;
    while (first.events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    first.close(); // simulate a dropped connection
    expect(first.events.length).toBeGreaterThan(0);
    const lastSeen = first.events[first.events.length - 1].id;

    await waitForState(id, 'A', ['completed']);
    const second = openSse(`/api/experiments/${id}/runs/A/events/stream`, lastSeen);
    await second.done;

    const all = [...first.events, ...second.events];
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicated events across reconnect
    expect(second.events.every((e) => e.id > lastSeen)).toBe(true);
    expect(all.some((e) => e.event === 'run_completed')).toBe(true);
  });
});
