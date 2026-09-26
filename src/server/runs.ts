import {randomUUID} from 'node:crypto';
import type {
  CachePolicy,
  OriginSnapshot,
  RunResult,
  Scenario,
  ScenarioEvent,
  Side,
  Tick,
} from '../shared/types';
import {runBoth} from './engine';

/**
 * Stateful but deterministic run holder.
 *
 * The logical clock advances in discrete steps; each advance recomputes both
 * sides against the SAME immutable snapshot and replay line. Runtime controls
 * (disconnect / reconnect / abort / cancel-side) are recorded as injected
 * events at the exact clock tick they arrived on, so the whole run stays
 * reproducible.
 */
interface ActiveRun {
  result: RunResult;
  scenario: Scenario;
  snapshot: OriginSnapshot;
  policyA: CachePolicy;
  policyB: CachePolicy;
  injectedA: ScenarioEvent[];
  injectedB: ScenarioEvent[];
  shutdownAtA: Tick | null;
  shutdownAtB: Tick | null;
  clock: Tick;
  speedTicksPerStep: number;
  timer: NodeJS.Timeout | null;
  /** hash of the draft selected for a slot at run creation */
  slotHashes: {a: string; b: string};
}

const MAX_TICK = 500;

export class RunManager {
  readonly runs = new Map<string, ActiveRun>();

  start(params: {
    scenario: Scenario;
    snapshot: OriginSnapshot;
    policyA: CachePolicy;
    policyB: CachePolicy;
    hashA: string;
    hashB: string;
  }): RunResult {
    const runId = randomUUID();
    const run: ActiveRun = {
      // placeholder result replaced in compute()
      result: {} as RunResult,
      scenario: params.scenario,
      snapshot: params.snapshot,
      policyA: params.policyA,
      policyB: params.policyB,
      injectedA: [],
      injectedB: [],
      shutdownAtA: null,
      shutdownAtB: null,
      clock: -1,
      speedTicksPerStep: 1,
      timer: null,
      slotHashes: {a: params.hashA, b: params.hashB},
    };
    this.runs.set(runId, run);
    return this.compute(runId, run.clock + 1);
  }

  get(runId: string): RunResult | null {
    return this.runs.get(runId)?.result ?? null;
  }

  isLive(runId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && run.result.status === 'running');
  }

  advance(runId: string, ticks = 1): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.result.status !== 'running') return run.result;
    return this.compute(runId, Math.min(MAX_TICK, run.clock + Math.max(1, ticks)));
  }

  /** Advance the clock to a target tick. */
  seek(runId: string, tick: Tick): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.result.status !== 'running') return run.result;
    if (tick <= run.clock) return run.result;
    return this.compute(runId, Math.min(MAX_TICK, tick));
  }

  /** Run automatically to completion with a small real-time delay per step. */
  play(runId: string, onTick: (result: RunResult) => void): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.timer) return run.result;
    run.timer = setInterval(() => {
      if (!run.timer) return;
      if (run.result.status !== 'running') {
        clearInterval(run.timer);
        run.timer = null;
        return;
      }
      this.compute(runId, Math.min(MAX_TICK, run.clock + run.speedTicksPerStep));
      onTick(run.result);
      if (run.result.status !== 'running') {
        if (run.timer) clearInterval(run.timer);
        run.timer = null;
      }
    }, 120);
    return run.result;
  }

  pause(runId: string): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.timer) {
      clearInterval(run.timer);
      run.timer = null;
    }
    return run.result;
  }

  setSpeed(runId: string, ticksPerStep: number): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    run.speedTicksPerStep = Math.max(1, Math.min(20, Math.floor(ticksPerStep)));
    return run.result;
  }

  inject(
    runId: string,
    side: Side | 'both',
    event: ScenarioEvent,
  ): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.result.status !== 'running') {
      throw new RunError('run_terminal', `run is ${run.result.status}; controls are locked`);
    }
    const stamped: ScenarioEvent = {...event, tick: run.clock, side: side === 'both' ? undefined : side};
    if (side === 'a' || side === 'both') run.injectedA.push(stamped);
    if (side === 'b' || side === 'both') run.injectedB.push({...stamped});
    return this.recompute(runId);
  }

  /**
   * Cancel ONE side only. Its state becomes terminal/cancelled and every later
   * request is reported as unpaired (side_X_cancelled); the other side keeps
   * running untouched.
   */
  cancelSide(runId: string, side: Side): RunResult {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('not_found', 'unknown run');
    if (run.result.status !== 'running') {
      throw new RunError('run_terminal', `run is ${run.result.status}`);
    }
    if (side === 'a') run.shutdownAtA = run.clock;
    else run.shutdownAtB = run.clock;
    return this.recompute(runId);
  }

  slotHash(runId: string, side: Side): string | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return side === 'a' ? run.slotHashes.a : run.slotHashes.b;
  }

  private compute(runId: string, clock: Tick): RunResult {
    const run = this.runs.get(runId)!;
    run.clock = clock;
    const complete = clock >= MAX_TICK;
    const result = runBoth({
      runId,
      scenario: run.scenario,
      snapshot: run.snapshot,
      policyA: run.policyA,
      policyB: run.policyB,
      injectedA: run.injectedA,
      injectedB: run.injectedB,
      shutdownAtA: run.shutdownAtA,
      shutdownAtB: run.shutdownAtB,
      horizon: complete ? null : clock,
      createdAt: run.result?.createdAt,
    });
    run.result = result;
    return result;
  }

  private recompute(runId: string): RunResult {
    const run = this.runs.get(runId)!;
    return this.compute(runId, run.clock);
  }
}

export class RunError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
