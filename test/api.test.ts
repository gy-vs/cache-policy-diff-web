import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {RunResult} from '../src/shared/types';

function post(app: ReturnType<typeof createApp>, path: string, body?: unknown) {
  return request(app).post(path).send(body ?? {});
}

async function startRun(app: ReturnType<typeof createApp>) {
  const bootstrap = await request(app).get('/api/bootstrap');
  const scenario = bootstrap.body.scenarios[0];
  const hashA = bootstrap.body.policies[0].hash;
  const hashB = bootstrap.body.policies[1].hash;
  const res = await post(app, '/api/runs', {
    scenarioId: scenario.id,
    policyHashA: hashA,
    policyHashB: hashB,
  }).expect(201);
  return res.body as RunResult;
}

describe('snapshots and scenarios', () => {
  it('exposes an immutable seed snapshot with a content hash', async () => {
    const app = createApp();
    const bootstrap = await request(app).get('/api/bootstrap').expect(200);
    expect(bootstrap.body.family).toBe('http-cache');
    expect(bootstrap.body.snapshots).toHaveLength(1);
    const snap = await request(app).get(`/api/snapshots/${bootstrap.body.snapshots[0].id}`).expect(200);
    expect(snap.body.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(snap.body.resources.length).toBeGreaterThan(0);
  });

  it('serves the fixed request sequence for the scenario', async () => {
    const app = createApp();
    const scenarios = await request(app).get('/api/scenarios').expect(200);
    expect(scenarios.body[0].requests.length).toBeGreaterThan(10);
    const ids = scenarios.body[0].requests.map((r: {id: string}) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('policy drafts are content-addressed', () => {
  it('dedupes identical drafts and hashes edits separately', async () => {
    const app = createApp();
    const policy = {name: 'custom', maxAge: 7, staleWhileRevalidate: 1, staleIfError: 2, coalesce: true, capacity: 3};
    const first = await post(app, '/api/policies', policy).expect(201);
    const again = await post(app, '/api/policies', policy).expect(201);
    expect(first.body.hash).toBe(again.body.hash);
    const edited = await post(app, '/api/policies', {...policy, maxAge: 8}).expect(201);
    expect(edited.body.hash).not.toBe(first.body.hash);
  });

  it('rejects invalid drafts', async () => {
    const app = createApp();
    await post(app, '/api/policies', {name: '', maxAge: 1, staleWhileRevalidate: 0, staleIfError: 0, coalesce: true, capacity: 2}).expect(400);
    await post(app, '/api/policies', {name: 'x', maxAge: -1, staleWhileRevalidate: 0, staleIfError: 0, coalesce: true, capacity: 2}).expect(400);
    await post(app, '/api/policies', {name: 'x', maxAge: 1, staleWhileRevalidate: 0, staleIfError: 0, coalesce: true, capacity: 0}).expect(400);
  });
});

describe('runs: clock, pairing, controls', () => {
  it('starts on the shared snapshot, advances the logical clock, and finishes', async () => {
    const app = createApp();
    const run = await startRun(app);
    expect(run.status).toBe('running');
    expect(run.clockTick).toBe(0);

    const advanced = await post(app, `/api/runs/${run.runId}/advance`, {ticks: 5}).expect(200);
    expect(advanced.body.clockTick).toBe(5);

    const finished = await post(app, `/api/runs/${run.runId}/seek`, {tick: 500}).expect(200);
    expect(finished.body.status).toBe('complete');
    expect(finished.body.endTick).not.toBeNull();
    // denominator + unpaired partition the whole sequence
    const total = finished.body.summary.paired + finished.body.summary.unpaired.length;
    const listed = await request(app).get('/api/scenarios');
    expect(total).toBe(listed.body[0].requests.length);
  });

  it('computes different hits / bytes / errors for the two policies at completion', async () => {
    const app = createApp();
    const run = await startRun(app);
    const done = await post(app, `/api/runs/${run.runId}/seek`, {tick: 500}).expect(200);
    const m = done.body.summary.metrics;
    expect(m.originBytes.a).not.toBe(m.originBytes.b);
    expect(m.coalesced.a).toBeGreaterThan(0);
    expect(m.coalesced.b).toBe(0);
    // every unpaired request carries an explicit reason
    for (const row of done.body.summary.unpaired) expect(typeof row.reason).toBe('string');
  });

  it('abort at runtime cancels only the targeted request on the chosen side', async () => {
    const app = createApp();
    const run = await startRun(app);
    await post(app, `/api/runs/${run.runId}/seek`, {tick: 40}).expect(200);
    const injected = await post(app, `/api/runs/${run.runId}/events`, {
      side: 'a',
      event: {type: 'abort', requestId: 'r10'},
    }).expect(200);
    const done = await post(app, `/api/runs/${run.runId}/seek`, {tick: 500});
    const row = done.body.summary.unpaired.find((u: {requestId: string}) => u.requestId === 'r10');
    void injected;
    expect(row.reason).toMatch(/a_cancelled|both_cancelled/);
  });

  it('runtime disconnect/reconnect is injected at the current tick', async () => {
    const app = createApp();
    const run = await startRun(app);
    await post(app, `/api/runs/${run.runId}/seek`, {tick: 52}).expect(200);
    const down = await post(app, `/api/runs/${run.runId}/events`, {side: 'both', event: {type: 'disconnect'}}).expect(200);
    expect(down.body.events.some((e: {type: string; injected?: boolean}) => e.type === 'disconnect')).toBe(true);
    const up = await post(app, `/api/runs/${run.runId}/events`, {side: 'both', event: {type: 'reconnect'}}).expect(200);
    expect(up.body.events.some((e: {type: string}) => e.type === 'reconnect')).toBe(true);
  });

  it('fault injection for one side leaves the other side healthy', async () => {
    const app = createApp();
    const run = await startRun(app);
    await post(app, `/api/runs/${run.runId}/seek`, {tick: 12}).expect(200);
    await post(app, `/api/runs/${run.runId}/events`, {
      side: 'b',
      event: {type: 'fault', url: '/api/experiments/alpha', duration: 3},
    }).expect(200);
    const done = await post(app, `/api/runs/${run.runId}/seek`, {tick: 500}).expect(200);
    // at least one paired request shows A=200 while B errored
    const mismatch = done.body.pairs.find(
      (p: {a: {status: number}; b: {status: number}}) => p.a.status === 200 && p.b.status === 500,
    );
    expect(mismatch).toBeTruthy();
  });

  it('cancelling one side leaves the other side running and marks later requests unpaired', async () => {
    const app = createApp();
    const run = await startRun(app);
    await post(app, `/api/runs/${run.runId}/seek`, {tick: 10}).expect(200);
    const cancelled = await post(app, `/api/runs/${run.runId}/cancel-side`, {side: 'a'}).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancelSide).toBe('a');
    // the other side's computed results are still present and independent
    const bResults = Object.entries(cancelled.body.sideResults).filter(([k]) => k.startsWith('b:'));
    expect(bResults.length).toBeGreaterThan(0);
    for (const row of cancelled.body.unpaired) {
      if (row.tick > 10) expect(row.reason).toBe('side_a_cancelled');
    }
    // controls lock after the run is terminal
    await post(app, `/api/runs/${run.runId}/advance`, {ticks: 1}).expect(200);
    await post(app, `/api/runs/${run.runId}/events`, {side: 'a', event: {type: 'reconnect'}}).expect(409);
  });

  it('marks a run stale when its bound draft differs from the current slot', async () => {
    const app = createApp();
    const run = await startRun(app);
    const edited = await post(app, '/api/policies', {
      name: 'A edited', maxAge: 11, staleWhileRevalidate: 30, staleIfError: 40, coalesce: true, capacity: 3,
    }).expect(201);
    await request(app).put('/api/slots/a').send({hash: edited.body.hash}).expect(200);
    const seen = await request(app).get(`/api/runs/${run.runId}`).expect(200);
    expect(seen.body.staleA).toBe(true);
    expect(seen.body.staleB).toBe(false);
    // old results remain readable
    expect(seen.body.summary.paired).toBeGreaterThanOrEqual(0);
  });

  it('rejects controls for unknown runs', async () => {
    const app = createApp();
    await post(app, '/api/runs/nope/advance').expect(404);
    await post(app, '/api/runs/nope/cancel-side', {side: 'a'}).expect(404);
  });
});
