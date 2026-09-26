import type {
  Bootstrap,
  CachePolicy,
  OriginSnapshot,
  RunStatus,
  Scenario,
  StoredPolicy,
} from '../shared/types';
import {hashPolicy, hashSnapshot} from './hash';
import {
  policyAggressive,
  policyConservative,
  seedPolicies,
  seedScenario,
  seedSnapshot,
} from './seeds';

export interface RunListing {
  runId: string;
  scenarioId: string;
  status: RunStatus;
  createdAt: string;
  policyHashA: string;
  policyHashB: string;
}

interface SlotSelection {
  hash: string;
}

/**
 * In-memory lab store.
 *
 * Invariants:
 *  - snapshots/scenarios are immutable once created;
 *  - policies are content-addressed: editing a draft inserts a NEW hash,
 *    old hashes (and old run results) remain available;
 *  - a run record keeps the hashes it was created from; the UI marks a run
 *    stale when the editor's current draft hash differs.
 */
export class Store {
  readonly snapshots = new Map<string, OriginSnapshot>();
  readonly scenarios = new Map<string, Scenario>();
  /** content hash -> stored policy (immutable) */
  readonly policies = new Map<string, StoredPolicy>();
  /** draft slot per side ('a' | 'b') -> currently selected hash */
  slots: Record<'a' | 'b', SlotSelection>;
  readonly runs = new Map<string, RunListing>();

  constructor() {
    this.putSnapshot(seedSnapshot);
    this.scenarios.set(seedScenario.id, structuredClone(seedScenario));
    const hashes: string[] = [];
    for (const policy of seedPolicies) hashes.push(this.putPolicy(policy).hash);
    this.slots = {a: {hash: hashPolicy(policyAggressive)}, b: {hash: hashPolicy(policyConservative)}};
  }

  putSnapshot(snapshot: OriginSnapshot): string {
    // defensive deep clone: callers can never mutate the stored snapshot
    const clone = structuredClone(snapshot);
    const hash = hashSnapshot({id: clone.id, resources: clone.resources});
    if (!this.snapshots.has(clone.id)) this.snapshots.set(clone.id, clone);
    return hash;
  }

  snapshotHash(id: string): string | null {
    const snapshot = this.snapshots.get(id);
    return snapshot ? hashSnapshot({id: snapshot.id, resources: snapshot.resources}) : null;
  }

  putScenario(scenario: Scenario) {
    if (!this.snapshots.has(scenario.snapshotId)) {
      throw new StoreError('unknown_snapshot', `snapshot ${scenario.snapshotId} does not exist`);
    }
    this.scenarios.set(scenario.id, structuredClone(scenario));
  }

  /** Insert (or return existing) content-addressed policy draft. */
  putPolicy(policy: CachePolicy): StoredPolicy {
    const hash = hashPolicy(policy);
    const existing = this.policies.get(hash);
    if (existing) return existing;
    const stored: StoredPolicy = {hash, policy: structuredClone(policy), createdAt: new Date().toISOString()};
    this.policies.set(hash, stored);
    return stored;
  }

  selectSlot(side: 'a' | 'b', hash: string) {
    if (!this.policies.has(hash)) throw new StoreError('unknown_policy', hash);
    this.slots[side] = {hash};
  }

  putRun(listing: RunListing) {
    this.runs.set(listing.runId, listing);
  }

  updateRunStatus(runId: string, status: RunStatus) {
    const listing = this.runs.get(runId);
    if (listing) listing.status = status;
  }

  bootstrap(): Bootstrap {
    return {
      family: 'http-cache',
      snapshots: [...this.snapshots.values()].map((s) => ({
        id: s.id,
        name: s.name,
        hash: this.snapshotHash(s.id)!,
      })),
      scenarios: [...this.scenarios.values()].map((s) => ({
        id: s.id,
        name: s.name,
        snapshotId: s.snapshotId,
      })),
      policies: [...this.policies.values()],
      runs: [...this.runs.values()].map(({runId, scenarioId, status, createdAt}) => ({
        runId,
        scenarioId,
        status,
        createdAt,
      })),
    };
  }
}

export class StoreError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
