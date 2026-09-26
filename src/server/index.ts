import express from 'express';
import {fileURLToPath} from 'node:url';
import type {CachePolicy, RunResult, ScenarioEvent, Side} from '../shared/types';
import {validatePolicy} from './engine';
import {RunError, RunManager} from './runs';
import {Store, StoreError} from './store';

export function createApp() {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  const store = new Store();
  const runs = new RunManager();

  const fail = (res: express.Response, status: number, error: string, detail?: string) =>
    res.status(status).json({error, ...(detail ? {detail} : {})});

  const runIdOf = (req: express.Request): string => String(req.params.id);


  // ---- static lab data -----------------------------------------------------

  app.get('/api/bootstrap', (_req, res) => res.json(store.bootstrap()));

  app.get('/api/snapshots/:id', (req, res) => {
    const snapshot = store.snapshots.get(String(req.params.id));
    if (!snapshot) return fail(res, 404, 'not_found');
    res.json({...snapshot, hash: store.snapshotHash(snapshot.id)});
  });

  app.get('/api/scenarios', (_req, res) => {
    res.json(
      [...store.scenarios.values()].map((scenario) => ({
        ...scenario,
        snapshotHash: store.snapshotHash(scenario.snapshotId),
      })),
    );
  });

  app.get('/api/scenarios/:id', (req, res) => {
    const scenario = store.scenarios.get(String(req.params.id));
    if (!scenario) return fail(res, 404, 'not_found');
    res.json(scenario);
  });

  // immutable-input guarantee: snapshots/scenarios can be added but not edited
  app.post('/api/snapshots', (req, res) => {
    const snapshot = req.body;
    if (!snapshot?.id || !Array.isArray(snapshot.resources)) {
      return fail(res, 400, 'invalid_snapshot', 'id and resources[] are required');
    }
    const hash = store.putSnapshot(snapshot);
    res.status(201).json({id: snapshot.id, hash});
  });

  app.post('/api/scenarios', (req, res) => {
    try {
      const scenario = req.body;
      if (!scenario?.id || !scenario.snapshotId || !Array.isArray(scenario.requests)) {
        return fail(res, 400, 'invalid_scenario', 'id, snapshotId and requests[] are required');
      }
      store.putScenario(scenario);
      res.status(201).json({id: scenario.id});
    } catch (error) {
      if (error instanceof StoreError) return fail(res, 400, error.code, error.message);
      throw error;
    }
  });

  // ---- policy drafts (content-addressed) -----------------------------------

  app.post('/api/policies', (req, res) => {
    const policy = req.body as CachePolicy;
    const problem = validatePolicy(policy);
    if (problem) return fail(res, 400, 'invalid_policy', problem);
    const stored = store.putPolicy(policy);
    res.status(201).json(stored);
  });

  app.get('/api/policies/:hash', (req, res) => {
    const stored = store.policies.get(req.params.hash);
    if (!stored) return fail(res, 404, 'not_found');
    res.json(stored);
  });

  /** Select a hash for an A/B draft slot. Old run results stay available. */
  app.put('/api/slots/:side', (req, res) => {
    const side = req.params.side as Side;
    if (side !== 'a' && side !== 'b') return fail(res, 400, 'bad_side');
    try {
      store.selectSlot(side, String(req.body?.hash ?? ''));
      res.json({side, hash: store.slots[side].hash});
    } catch (error) {
      if (error instanceof StoreError) return fail(res, 400, error.code, error.message);
      throw error;
    }
  });

  app.get('/api/slots', (_req, res) => res.json(store.slots));

  // ---- runs ----------------------------------------------------------------

  app.post('/api/runs', (req, res) => {
    const scenarioId = String(req.body?.scenarioId || (store.scenarios.keys().next().value ?? ''));
    const scenario = store.scenarios.get(scenarioId);
    if (!scenario) return fail(res, 404, 'unknown_scenario', scenarioId);
    const snapshot = store.snapshots.get(scenario.snapshotId);
    if (!snapshot) return fail(res, 404, 'unknown_snapshot', scenario.snapshotId);

    // resolve drafts: explicit hashes, else current slot selection
    const hashA = String(req.body?.policyHashA ?? store.slots.a.hash);
    const hashB = String(req.body?.policyHashB ?? store.slots.b.hash);
    const storedA = store.policies.get(hashA);
    const storedB = store.policies.get(hashB);
    if (!storedA) return fail(res, 400, 'unknown_policy', `side A hash ${hashA}`);
    if (!storedB) return fail(res, 400, 'unknown_policy', `side B hash ${hashB}`);

    const result = runs.start({
      scenario,
      snapshot,
      policyA: storedA.policy,
      policyB: storedB.policy,
      hashA,
      hashB,
    });
    store.putRun({
      runId: result.runId,
      scenarioId,
      status: result.status,
      createdAt: result.createdAt,
      policyHashA: hashA,
      policyHashB: hashB,
    });
    res.status(201).json(decorate(result));
  });

  app.get('/api/runs', (_req, res) => {
    res.json(
      [...store.runs.values()].map((listing) => {
        const result = runs.get(listing.runId);
        return {
          ...listing,
          // stale marker: run bound to a different draft than the current slot
          staleA: result ? result.policyHashA !== store.slots.a.hash : false,
          staleB: result ? result.policyHashB !== store.slots.b.hash : false,
          clockTick: result?.clockTick ?? null,
          paired: result?.summary.paired ?? 0,
        };
      }),
    );
  });

  app.get('/api/runs/:id', (req, res) => {
    const result = runs.get(runIdOf(req));
    if (!result) return fail(res, 404, 'not_found');
    res.json(decorate(result));
  });

  app.post('/api/runs/:id/advance', (req, res) => {
    withRun(req, res, (id) => runs.advance(id, Number(req.body?.ticks ?? 1)));
  });

  app.post('/api/runs/:id/seek', (req, res) => {
    withRun(req, res, (id) => runs.seek(id, Number(req.body?.tick ?? 0)));
  });

  app.post('/api/runs/:id/play', (req, res) => {
    const id = runIdOf(req);
    withRun(req, res, () => {
      runs.play(id, (updated) => store.updateRunStatus(id, updated.status));
      return runs.get(id)!;
    });
  });

  app.post('/api/runs/:id/pause', (req, res) => {
    withRun(req, res, (id) => runs.pause(id));
  });

  app.post('/api/runs/:id/speed', (req, res) => {
    withRun(req, res, (id) => runs.setSpeed(id, Number(req.body?.ticksPerStep ?? 1)));
  });

  /** Inject disconnect / reconnect / abort / fault at the CURRENT logical tick. */
  app.post('/api/runs/:id/events', (req, res) => {
    const side = (String(req.body?.side ?? 'both')) as Side | 'both';
    if (side !== 'a' && side !== 'b' && side !== 'both') {
      return fail(res, 400, 'bad_side');
    }
    const event = req.body?.event as ScenarioEvent | undefined;
    if (!event?.type) return fail(res, 400, 'invalid_event', 'event.type required');
    const allowed: ScenarioEvent['type'][] = ['disconnect', 'reconnect', 'abort', 'fault'];
    if (!allowed.includes(event.type)) {
      return fail(res, 400, 'invalid_event', `runtime controls allow: ${allowed.join(', ')}`);
    }
    withRun(req, res, (id) => runs.inject(id, side, event));
  });

  /** Cancel exactly one side; the other side's run is unaffected. */
  app.post('/api/runs/:id/cancel-side', (req, res) => {
    const side = String(req.body?.side ?? '') as Side;
    if (side !== 'a' && side !== 'b') return fail(res, 400, 'bad_side');
    withRun(req, res, (id) => runs.cancelSide(id, side));
  });

  function withRun(
    req: express.Request,
    res: express.Response,
    action: (id: string) => RunResult,
  ) {
    const id = runIdOf(req);
    if (!runs.get(id)) return fail(res, 404, 'not_found');
    try {
      const next = action(id);
      store.updateRunStatus(id, next.status);
      res.json(decorate(next));
    } catch (error) {
      if (error instanceof RunError) {
        return fail(res, error.code === 'not_found' ? 404 : 409, error.code, error.message);
      }
      throw error;
    }
  }

  /** Add slot-staleness flags so the UI can mark old results expired. */
  function decorate(result: RunResult) {
    return {
      ...result,
      staleA: result.policyHashA !== store.slots.a.hash,
      staleB: result.policyHashB !== store.slots.b.hash,
    };
  }

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
