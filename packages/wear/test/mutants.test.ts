// Every mutant in scripts/mutants.ts is a plausible porting mistake. Each must
// fail at least one frozen vector, or the vectors do not protect the contract.
import { describe, expect, it } from 'vitest';
import { MUTANTS, runMutants } from '../scripts/mutants';

describe('wear-vectors.json kills every mutant', () => {
  it('the unmutated copy passes every vector, and no mutant survives', async () => {
    const { baselineFailures, results } = await runMutants();
    expect(baselineFailures).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(MUTANTS.map((m) => m.name));
    const survivors = results.filter((r) => r.killedBy.length === 0).map((r) => r.name);
    expect(survivors).toEqual([]);
  }, 120_000);
});
