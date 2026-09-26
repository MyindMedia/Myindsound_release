// §11.6 test 1 (TypeScript half): the frozen vectors reproduce byte for byte.
// The Swift port (P7) runs the same file. Regenerate only with a new wearModelVersion.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeWear } from '../src/computeWear';
import { serializeDescriptor } from '../src/serialize';
import type { WearVectorFile } from '../scripts/vector-cases';

// Frozen: bump only when scripts/gen-vectors.ts --force appends cases.
const FROZEN_CASE_COUNT = 186;

const text = readFileSync(fileURLToPath(new URL('../wear-vectors.json', import.meta.url)), 'utf8');
const recordedSha = readFileSync(fileURLToPath(new URL('../wear-vectors.sha256', import.meta.url)), 'utf8').split(/\s+/)[0];
const file = JSON.parse(text) as WearVectorFile;

describe('wear-vectors.json', () => {
  it('is byte for byte the frozen file recorded in wear-vectors.sha256', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(recordedSha);
    expect(recordedSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has exactly the frozen number of cases (PRD asks for at least 50)', () => {
    expect(file.format).toBe(1);
    expect(file.cases.length).toBe(FROZEN_CASE_COUNT);
    expect(new Set(file.cases.map((c) => c.name)).size).toBe(file.cases.length);
  });

  it('keeps negative zero stats as -0 in the file', () => {
    expect(text).toContain('"playSeconds": -0');
    const c = file.cases.find((x) => x.name === 'negative zero stats');
    expect(Object.is(c?.input.stats.playSeconds, -0)).toBe(true);
  });

  it('covers every category the gauntlet asks for', () => {
    const tags = new Set(file.cases.flatMap((c) => c.tags));
    for (const t of ['zero', 'tiny', 'mid', 'saturated', 'lent-heavy', 'handling-only', 'huge', 'safe-zones', 'no-safe-zones', 'error', 'rounding-edge', 'mixed-edge', 'zone-edge', 'threshold']) {
      expect(tags.has(t), t).toBe(true);
    }
    expect(new Set(file.cases.map((c) => c.input.seed)).size).toBeGreaterThanOrEqual(8);
  });

  for (const c of file.cases) {
    it(`reproduces ${c.name}`, () => {
      const run = () =>
        computeWear(c.input.seed, c.input.stats, c.input.version, { wearSafeZones: c.input.wearSafeZones as never });
      if (c.expectedError !== undefined) {
        expect(run).toThrow(c.expectedError);
      } else {
        expect(serializeDescriptor(run())).toBe(c.expected);
      }
    });
  }
});
