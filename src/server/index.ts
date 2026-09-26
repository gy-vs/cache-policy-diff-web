import express, {NextFunction, Request, Response} from 'express';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LabError, Side, SIDES} from './domain';
import {LabStore} from './store';

const TERMINAL_EVENTS = new Set(['run_completed', 'run_cancelled', 'run_failed']);

function parseSide(value: string): Side {
  if (value === 'A' || value === 'B') return value;
  throw new LabError(400, 'bad_request', `side must be A or B, got ${value}`);
}

export function createApp(store = new LabStore()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/experiments', (_req, res) => {
    res.json(
      store.list().map((experiment) => ({
        id: experiment.id,
        createdAt: experiment.createdAt,
        snapshotHash: experiment.snapshotHash,
        requests: experiment.snapshot.requests.length,
        runs: Object.fromEntries(
          SIDES.filter((side) => experiment.runs[side]).map((side) => [side, experiment.runs[side]!.state]),
        ),
      })),
    );
  });

  app.post('/api/experiments', (req, res) => {
    const body = (req.body ?? {}) as {snapshot?: unknown; drafts?: unknown};
    if (body.snapshot === undefined) throw new LabError(422, 'invalid_snapshot', 'snapshot is required');
    const experiment = store.createExperiment(body.snapshot, body.drafts);
    res.status(201).json(store.experimentView(experiment));
  });

  app.get('/api/experiments/:id', (req, res) => {
    res.json(store.experimentView(store.get(req.params.id)));
  });

  app.put('/api/experiments/:id/drafts/:side', (req, res) => {
    const side = parseSide(req.params.side);
    const text = (req.body as {text?: unknown})?.text;
    if (typeof text !== 'string') throw new LabError(400, 'bad_request', 'text must be a string');
    const result = store.updateDraft(req.params.id, side, text);
    res.json({side, hash: result.draft.hash, staleMarked: result.staleMarked});
  });

  app.post('/api/experiments/:id/runs', (req, res) => {
    const body = (req.body ?? {}) as {sides?: unknown; stepDelayMs?: unknown};
    const sides: Side[] =
      body.sides === undefined
        ? [...SIDES]
        : Array.isArray(body.sides)
          ? body.sides.map((s) => parseSide(String(s)))
          : (() => {
              throw new LabError(400, 'bad_request', 'sides must be an array');
            })();
    const stepDelayMs = body.stepDelayMs === undefined ? 8 : Number(body.stepDelayMs);
    if (!Number.isFinite(stepDelayMs) || stepDelayMs < 0 || stepDelayMs > 1000)
      throw new LabError(400, 'bad_request', 'stepDelayMs must be between 0 and 1000');
    const runs = sides.map((side) => store.startRun(req.params.id, side, stepDelayMs));
    res.status(202).json({runs: runs.map((run) => store.runView(run))});
  });

  app.post('/api/experiments/:id/runs/:side/cancel', (req, res) => {
    const run = store.cancelRun(req.params.id, parseSide(req.params.side));
    res.json(store.runView(run));
  });

  app.get('/api/experiments/:id/runs/:side/events', (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isFinite(after) || after < 0) throw new LabError(400, 'bad_request', 'after must be a number >= 0');
    res.json(store.eventsAfter(req.params.id, parseSide(req.params.side), after));
  });

  // SSE stream; reconnects resume from Last-Event-ID (or ?after=) without loss or duplication.
  app.get('/api/experiments/:id/runs/:side/events/stream', (req, res) => {
    const experiment = store.get(req.params.id);
    const side = parseSide(req.params.side);
    const run = experiment.runs[side];
    if (!run) throw new LabError(404, 'not_found', `no run for side ${side}`);

    const lastEventId = req.header('last-event-id');
    const after = lastEventId !== undefined ? Number(lastEventId) : Number(req.query.after ?? 0);
    const cursor = Number.isFinite(after) && after >= 0 ? after : 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': ok\n\n');

    let closed = false;
    const send = (event: {seq: number; type: string}) => {
      if (closed || event.seq <= cursor) return;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (TERMINAL_EVENTS.has(event.type)) close();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      run.emitter.off('event', onEvent);
      res.end();
    };
    const onEvent = (event: {seq: number; type: string}) => send(event);

    for (const event of run.events) send(event); // replay backlog first
    if (!closed) {
      run.emitter.on('event', onEvent);
      req.on('close', close);
    }
  });

  app.get('/api/experiments/:id/summary', (req, res) => {
    res.json(store.buildSummary(req.params.id));
  });

  // In production, serve the built client.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof LabError) {
      res.status(error.status).json({error: error.code, message: error.message});
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({error: 'internal', message});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  createApp().listen(port, '127.0.0.1', () => console.log(`server http://127.0.0.1:${port}`));
}
