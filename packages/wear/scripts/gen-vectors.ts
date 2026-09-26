// Generates and guards packages/wear/wear-vectors.json, the frozen §11.6 test 1 vectors.
//
//   npx tsx packages/wear/scripts/gen-vectors.ts          # verify: exit 1 on any drift
//   npx tsx packages/wear/scripts/gen-vectors.ts --force  # APPEND new cases only
//
// The file is frozen and append only. Every existing case must regenerate to the
// same bytes (input and expected), in the same order; --force refuses otherwise.
// New cases (names not yet in the file) are appended at the end, and
// wear-vectors.sha256 is rewritten. Changing a v1 output needs a new
// wearModelVersion, never an edit here.
//
// The first write happens only when neither wear-vectors.json nor
// wear-vectors.sha256 exists.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeWear } from '../src/computeWear';
import { serializeDescriptor } from '../src/serialize';
import { buildCases, type WearVectorCase, type WearVectorFile } from './vector-cases';

const OUT = fileURLToPath(new URL('../wear-vectors.json', import.meta.url));
const SHA = fileURLToPath(new URL('../wear-vectors.sha256', import.meta.url));
const NOTE =
  'Frozen wear test vectors (PRD 11.6 test 1). For each case, computeWear(input) serialised with ' +
  'serializeDescriptor must equal `expected` byte for byte, or throw an error containing `expectedError`. ' +
  'An absent wearSafeZones means no zones. Append only: see packages/wear/README.md section 8.';

const NEG_ZERO = '__wear_negative_zero__';

/** JSON with 2 space indent, writing -0 as `-0` (JSON.stringify would drop the sign). */
export function renderJson(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => (Object.is(v, -0) ? NEG_ZERO : v), 2);
  return text.split(`"${NEG_ZERO}"`).join('-0');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function withExpected(c: WearVectorCase): WearVectorCase {
  try {
    const d = computeWear(c.input.seed, c.input.stats, c.input.version, {
      wearSafeZones: c.input.wearSafeZones as never,
    });
    if (c.expectedError !== undefined) throw new Error(`case "${c.name}" was expected to throw`);
    return { name: c.name, tags: c.tags, input: c.input, expected: serializeDescriptor(d) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (c.expectedError === undefined || !msg.includes(c.expectedError)) throw e;
    return c;
  }
}

function main(): void {
  const force = process.argv.includes('--force');
  const built = buildCases().map(withExpected);
  const names = new Set<string>();
  for (const c of built) {
    if (names.has(c.name)) throw new Error(`duplicate case name: ${c.name}`);
    names.add(c.name);
  }

  const hasFile = existsSync(OUT);
  const hasSha = existsSync(SHA);
  if (!hasFile && !hasSha) {
    const text = `${renderJson({ format: 1, note: NOTE, cases: built } satisfies WearVectorFile)}\n`;
    writeFileSync(OUT, text);
    writeFileSync(SHA, `${sha256(text)}  wear-vectors.json\n`);
    console.log(`wrote ${built.length} cases, sha256 ${sha256(text)}`);
    return;
  }
  if (!hasFile || !hasSha) {
    console.error('wear-vectors.json or wear-vectors.sha256 is missing. The vectors are frozen: restore it from git.');
    process.exit(1);
  }

  const text = readFileSync(OUT, 'utf8');
  const recorded = readFileSync(SHA, 'utf8').split(/\s+/)[0];
  if (sha256(text) !== recorded) {
    console.error(`wear-vectors.json does not match wear-vectors.sha256 (${sha256(text)} vs ${recorded}).`);
    process.exit(1);
  }
  const frozen = JSON.parse(text) as WearVectorFile;
  const byName = new Map(built.map((c) => [c.name, c]));
  const problems: string[] = [];
  for (const old of frozen.cases) {
    const now = byName.get(old.name);
    if (now === undefined) problems.push(`removed: ${old.name}`);
    else if (renderJson(now) !== renderJson(old)) problems.push(`changed: ${old.name}`);
  }
  const frozenNames = new Set(frozen.cases.map((c) => c.name));
  const fresh = built.filter((c) => !frozenNames.has(c.name));

  if (problems.length > 0) {
    console.error(`${problems.length} frozen case(s) would change. Refusing (use a new wearModelVersion):`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    process.exit(1);
  }
  if (fresh.length === 0) {
    console.log(`wear-vectors.json up to date (${frozen.cases.length} cases, sha256 ${recorded})`);
    return;
  }
  if (!force) {
    console.error(`${fresh.length} new case(s) not in the file. Run with --force to append them.`);
    process.exit(1);
  }
  const next = `${renderJson({ ...frozen, cases: [...frozen.cases, ...fresh] })}\n`;
  writeFileSync(OUT, next);
  writeFileSync(SHA, `${sha256(next)}  wear-vectors.json\n`);
  console.log(`appended ${fresh.length} case(s): now ${frozen.cases.length + fresh.length}, sha256 ${sha256(next)}`);
  console.log('Update FROZEN_CASE_COUNT in test/vectors.test.ts to match.');
}

main();
