import {createHash} from 'node:crypto';
import type {CachePolicy} from '../shared/types';

/** Stable canonical JSON (sorted keys) so hashes are content-based. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Content hash binding a policy draft to its computed results. */
export function hashPolicy(policy: CachePolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex').slice(0, 12);
}

export function hashSnapshot(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);
}
