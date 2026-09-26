import {EventEmitter} from 'node:events';
import {
  hashJson,
  hashText,
  InputSnapshot,
  LabError,
  parsePolicy,
  PolicyConfig,
  RunEvent,
  seedDrafts,
  seedSnapshot,
  Side,
  SIDES,
  validateSnapshot,
} from './domain';
import {executeRun} from './engine';

export type RunStateName = 'running' | 'completed' | 'cancelled' | 'failed';

export interface RunState {
  side: Side;
  state: RunStateName;
  policyHash: string;
  snapshotHash: string;
  events: RunEvent[];
  emitter: EventEmitter;
  startedAt: string;
  endedAt?: string;
  error?: {code: string; message: string};
  cancelRequested: boolean;
  stepDelayMs: number;
}

export interface Draft {
  text: string;
  hash: string;
}

export interface Experiment {
  id: string;
  createdAt: string;
  snapshot: InputSnapshot; // immutable after creation
  snapshotHash: string;
  drafts: Record<Side, Draft>;
  runs: Partial<Record<Side, RunState>>;
}

export interface SideTotals {
  requests: number;
  hits: number;
  misses: number;
  revalidated: number;
  stale: number;
  coalesced: number;
  bypass: number;
  errors: number;
  originFetches: number;
  originBytes: number;
  clientBytes: number;
}

export interface Summary {
  experimentId: string;
  snapshotHash: string;
  policyHashes: Record<Side, string>;
  runPolicyHashes: Partial<Record<Side, string>>;
  stale: Record<Side, boolean>;
  runStates: Partial<Record<Side, RunStateName>>;
  totalRequests: number;
  paired: number; // denominator: requests completed on BOTH sides
  comparisonComplete: boolean;
  totals: {A: SideTotals; B: SideTotals; originBytesDelta: number; clientBytesDelta: number};
  rows: Array<{
    requestId: string;
    at: number;
    url: string;
    A: {outcome: string; originBytes: number; clientBytes: number};
    B: {outcome: string; originBytes: number; clientBytes: number};
    originBytesDelta: number;
  }>;
  unpaired: Array<{requestId: string; missing: Side[]; reasons: Partial<Record<Side, string>>}>;
}

const newTotals = (): SideTotals => ({
  requests: 0,
  hits: 0,
  misses: 0,
  revalidated: 0,
  stale: 0,
  coalesced: 0,
  bypass: 0,
  errors: 0,
  originFetches: 0,
  originBytes: 0,
  clientBytes: 0,
});

export class LabStore {
  private experiments = new Map<string, Experiment>();
  private nextId = 1;

  constructor() {
    // Seed one ready-to-run experiment so the UI works out of the box.
    this.createExperiment(seedSnapshot(), seedDrafts(), 'lab');
  }

  createExperiment(snapshotRaw: unknown, draftsRaw?: unknown, forcedId?: string): Experiment {
    const snapshot = validateSnapshot(snapshotRaw);
    let drafts: Record<Side, string>;
    if (draftsRaw === undefined) {
      drafts = seedDrafts();
    } else {
      if (typeof draftsRaw !== 'object' || draftsRaw === null)
        throw new LabError(422, 'invalid_snapshot', 'drafts must be an object with A and B text');
      const d = draftsRaw as Record<string, unknown>;
      if (typeof d.A !== 'string' || typeof d.B !== 'string')
        throw new LabError(422, 'invalid_snapshot', 'drafts.A and drafts.B must be strings');
      drafts = {A: d.A, B: d.B};
    }
    const id = forcedId ?? `exp-${this.nextId++}`;
    if (this.experiments.has(id)) throw new LabError(409, 'experiment_exists', `experiment ${id} exists`);
    const experiment: Experiment = {
      id,
      createdAt: new Date().toISOString(),
      snapshot: Object.freeze(snapshot) as InputSnapshot,
      snapshotHash: hashJson(snapshot),
      drafts: {
        A: {text: drafts.A, hash: hashText(drafts.A)},
        B: {text: drafts.B, hash: hashText(drafts.B)},
      },
      runs: {},
    };
    this.experiments.set(id, experiment);
    return experiment;
  }

  get(id: string): Experiment {
    const experiment = this.experiments.get(id);
    if (!experiment) throw new LabError(404, 'not_found', `experiment ${id} not found`);
    return experiment;
  }

  list(): Experiment[] {
    return [...this.experiments.values()];
  }

  updateDraft(id: string, side: Side, text: string): {draft: Draft; staleMarked: boolean} {
    const experiment = this.get(id);
    const draft = {text, hash: hashText(text)};
    experiment.drafts[side] = draft;
    const run = experiment.runs[side];
    // Old run results stay in place; they are merely flagged stale via hash mismatch.
    return {draft, staleMarked: !!run && run.policyHash !== draft.hash};
  }

  startRun(id: string, side: Side, stepDelayMs = 8): RunState {
    const experiment = this.get(id);
    const existing = experiment.runs[side];
    if (existing && existing.state === 'running')
      throw new LabError(409, 'already_running', `run ${side} already running`);

    const draft = experiment.drafts[side];
    let policy: PolicyConfig;
    try {
      policy = parsePolicy(draft.text);
    } catch (error) {
      if (error instanceof LabError)
        throw new LabError(422, 'policy_invalid', `draft ${side}: ${error.message}`);
      throw error;
    }

    const run: RunState = {
      side,
      state: 'running',
      policyHash: draft.hash,
      snapshotHash: experiment.snapshotHash,
      events: [],
      emitter: new EventEmitter(),
      startedAt: new Date().toISOString(),
      cancelRequested: false,
      stepDelayMs,
    };
    run.emitter.setMaxListeners(50);
    experiment.runs[side] = run;

    const append = (event: Omit<RunEvent, 'seq'>) => {
      const full: RunEvent = {...event, seq: run.events.length + 1};
      run.events.push(full);
      run.emitter.emit('event', full);
    };

    void (async () => {
      try {
        const result = await executeRun(experiment.snapshot, policy, side, {
          emit: append,
          cancelled: () => run.cancelRequested,
          stepDelayMs,
        });
        run.state = result.state === 'completed' ? 'completed' : result.state === 'cancelled' ? 'cancelled' : 'failed';
        if (result.error) run.error = result.error;
      } catch (error) {
        run.state = 'failed';
        run.error = {code: 'internal', message: error instanceof Error ? error.message : String(error)};
        append({type: 'run_failed', detail: run.error});
      } finally {
        run.endedAt = new Date().toISOString();
      }
    })();

    return run;
  }

  cancelRun(id: string, side: Side): RunState {
    const experiment = this.get(id);
    const run = experiment.runs[side];
    if (!run) throw new LabError(404, 'not_found', `no run for side ${side}`);
    if (run.state !== 'running') throw new LabError(409, 'not_running', `run ${side} is ${run.state}`);
    run.cancelRequested = true;
    return run;
  }

  eventsAfter(id: string, side: Side, after: number): {events: RunEvent[]; state: RunStateName; latestSeq: number} {
    const experiment = this.get(id);
    const run = experiment.runs[side];
    if (!run) throw new LabError(404, 'not_found', `no run for side ${side}`);
    return {
      events: run.events.filter((event) => event.seq > after),
      state: run.state,
      latestSeq: run.events.length,
    };
  }

  // --- pairing: align both sides on the original request id ---

  buildSummary(id: string): Summary {
    const experiment = this.get(id);
    const runA = experiment.runs.A;
    const runB = experiment.runs.B;

    const requestEvents = (run: RunState | undefined) => {
      const map = new Map<string, RunEvent>();
      if (run) for (const event of run.events) if (event.type === 'request' && event.requestId) map.set(event.requestId, event);
      return map;
    };
    const eventsA = requestEvents(runA);
    const eventsB = requestEvents(runB);

    const missingReason = (run: RunState | undefined): string => {
      if (!run) return 'not_started';
      switch (run.state) {
        case 'running':
          return 'in_progress';
        case 'cancelled':
          return 'cancelled';
        case 'failed':
          return 'failed';
        case 'completed':
          return 'absent';
      }
    };

    const totalsA = newTotals();
    const totalsB = newTotals();
    const rows: Summary['rows'] = [];
    const unpaired: Summary['unpaired'] = [];

    const accumulate = (totals: SideTotals, event: RunEvent) => {
      totals.requests += 1;
      totals.originBytes += event.originBytes ?? 0;
      totals.clientBytes += event.clientBytes ?? 0;
      if ((event.originBytes ?? 0) > 0) totals.originFetches += 1;
      switch (event.outcome) {
        case 'hit':
          totals.hits += 1;
          break;
        case 'miss':
          totals.misses += 1;
          break;
        case 'revalidated':
          totals.revalidated += 1;
          break;
        case 'stale':
          totals.stale += 1;
          break;
        case 'coalesced':
          totals.coalesced += 1;
          break;
        case 'bypass':
          totals.bypass += 1;
          break;
        case 'error':
          totals.errors += 1;
          break;
      }
    };

    for (const request of experiment.snapshot.requests) {
      const a = eventsA.get(request.id);
      const b = eventsB.get(request.id);
      if (a && b) {
        accumulate(totalsA, a);
        accumulate(totalsB, b);
        rows.push({
          requestId: request.id,
          at: request.at,
          url: request.url,
          A: {outcome: a.outcome ?? 'error', originBytes: a.originBytes ?? 0, clientBytes: a.clientBytes ?? 0},
          B: {outcome: b.outcome ?? 'error', originBytes: b.originBytes ?? 0, clientBytes: b.clientBytes ?? 0},
          originBytesDelta: (b.originBytes ?? 0) - (a.originBytes ?? 0),
        });
      } else {
        const missing: Side[] = [];
        const reasons: Partial<Record<Side, string>> = {};
        if (!a) {
          missing.push('A');
          reasons.A = missingReason(runA);
        }
        if (!b) {
          missing.push('B');
          reasons.B = missingReason(runB);
        }
        unpaired.push({requestId: request.id, missing, reasons});
      }
    }

    const runStates: Partial<Record<Side, RunStateName>> = {};
    const runPolicyHashes: Partial<Record<Side, string>> = {};
    for (const side of SIDES) {
      const run = experiment.runs[side];
      if (run) {
        runStates[side] = run.state;
        runPolicyHashes[side] = run.policyHash;
      }
    }

    return {
      experimentId: experiment.id,
      snapshotHash: experiment.snapshotHash,
      policyHashes: {A: experiment.drafts.A.hash, B: experiment.drafts.B.hash},
      runPolicyHashes,
      stale: {
        A: !!runA && runA.policyHash !== experiment.drafts.A.hash,
        B: !!runB && runB.policyHash !== experiment.drafts.B.hash,
      },
      runStates,
      totalRequests: experiment.snapshot.requests.length,
      paired: rows.length,
      comparisonComplete:
        runA?.state === 'completed' && runB?.state === 'completed' && rows.length === experiment.snapshot.requests.length,
      totals: {
        A: totalsA,
        B: totalsB,
        originBytesDelta: totalsB.originBytes - totalsA.originBytes,
        clientBytesDelta: totalsB.clientBytes - totalsA.clientBytes,
      },
      rows,
      unpaired,
    };
  }

  // --- serializable views ---

  runView(run: RunState) {
    return {
      side: run.side,
      state: run.state,
      policyHash: run.policyHash,
      snapshotHash: run.snapshotHash,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: run.error,
      eventCount: run.events.length,
    };
  }

  experimentView(experiment: Experiment) {
    const runs: Partial<Record<Side, ReturnType<LabStore['runView']>>> = {};
    const stale: Partial<Record<Side, boolean>> = {};
    for (const side of SIDES) {
      const run = experiment.runs[side];
      if (run) {
        runs[side] = this.runView(run);
        stale[side] = run.policyHash !== experiment.drafts[side].hash;
      }
    }
    return {
      id: experiment.id,
      createdAt: experiment.createdAt,
      snapshotHash: experiment.snapshotHash,
      snapshot: experiment.snapshot,
      drafts: {
        A: {text: experiment.drafts.A.text, hash: experiment.drafts.A.hash},
        B: {text: experiment.drafts.B.text, hash: experiment.drafts.B.hash},
      },
      runs,
      stale,
    };
  }
}
