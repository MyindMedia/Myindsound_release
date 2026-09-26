// Mutation harness for wear-vectors.json.
//
//   npx tsx packages/wear/scripts/mutants.ts
//
// Each mutant is a plausible porting mistake, applied as a source edit to a
// temporary copy of src/. The mutant must fail at least one frozen vector
// (wrong bytes, or wrong throw/no-throw). Exits 1 if the unmutated copy fails
// any vector, if an edit no longer applies, or if any mutant survives.
// test/mutants.test.ts runs the same harness under vitest.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WearVectorFile } from './vector-cases';

type SrcFile = 'computeWear.ts' | 'config.ts' | 'prng.ts' | 'serialize.ts';

export interface Mutant {
  name: string;
  why: string;
  edits: Array<{ file: SrcFile; find: string; replace: string }>;
}

const EFF = `  const eff =
    (s.playSeconds + cfg.LENT_WEIGHT * s.lentPlaySeconds) / cfg.SECONDS_PER_PLAY +
    cfg.LOAD_WEIGHT * s.loads +
    cfg.EJECT_WEIGHT * s.ejects;`;
const PLAY = '(s.playSeconds + cfg.LENT_WEIGHT * s.lentPlaySeconds) / cfg.SECONDS_PER_PLAY';
const LOADS = 'cfg.LOAD_WEIGHT * s.loads';
const EJECTS = 'cfg.EJECT_WEIGHT * s.ejects';
const eff = (expr: string): Mutant['edits'] => [{ file: 'computeWear.ts', find: EFF, replace: `  const eff = ${expr};` }];
const LEVEL = 'const level = cfg.MAX_WEAR * (1 - expNeg(cfg.K * eff));';
const level = (expr: string): Mutant['edits'] => [{ file: 'computeWear.ts', find: LEVEL, replace: `const level = ${expr};` }];
const cw = (find: string, replace: string): Mutant['edits'] => [{ file: 'computeWear.ts', find, replace }];

export const MUTANTS: Mutant[] = [
  // Level: evaluation order (§2 of the README).
  { name: 'splitDiv', why: 'play/180 + lent/180 instead of (play + lent)/180', edits: eff(`s.playSeconds / cfg.SECONDS_PER_PLAY + (cfg.LENT_WEIGHT * s.lentPlaySeconds) / cfg.SECONDS_PER_PLAY + ${LOADS} + ${EJECTS}`) },
  { name: 'lentFirst', why: 'lent term summed first, play term last', edits: eff(`(cfg.LENT_WEIGHT * s.lentPlaySeconds) / cfg.SECONDS_PER_PLAY + ${LOADS} + ${EJECTS} + s.playSeconds / cfg.SECONDS_PER_PLAY`) },
  { name: 'handlingFirst', why: 'loads and ejects added before the play term', edits: eff(`${LOADS} + ${EJECTS} + ${PLAY}`) },
  { name: 'handlingGrouped', why: 'play + (loads + ejects terms)', edits: eff(`${PLAY} + (${LOADS} + ${EJECTS})`) },
  { name: 'ejectsBeforeLoads', why: 'eject term added before the load term', edits: eff(`${PLAY} + ${EJECTS} + ${LOADS}`) },
  { name: 'loadsPlusEjectsHalf', why: '(loads + ejects) * 0.5', edits: eff(`${PLAY} + (s.loads + s.ejects) * cfg.LOAD_WEIGHT`) },
  { name: 'mulRecip', why: '* (1/180) instead of / 180', edits: eff(`(s.playSeconds + cfg.LENT_WEIGHT * s.lentPlaySeconds) * (1 / cfg.SECONDS_PER_PLAY) + ${LOADS} + ${EJECTS}`) },
  { name: 'kDistributed', why: 'K folded into each term', edits: level(`cfg.MAX_WEAR * (1 - expNeg((s.playSeconds + cfg.LENT_WEIGHT * s.lentPlaySeconds) * (cfg.K / cfg.SECONDS_PER_PLAY) + cfg.K * cfg.LOAD_WEIGHT * s.loads + cfg.K * cfg.EJECT_WEIGHT * s.ejects))`) },
  { name: 'mathExp', why: 'platform exp instead of expNeg', edits: level('cfg.MAX_WEAR * (1 - Math.exp(-(cfg.K * eff)))') },
  { name: 'expm1', why: '-expm1 instead of 1 - expNeg', edits: level('cfg.MAX_WEAR * -Math.expm1(-(cfg.K * eff))') },
  // expNeg internals.
  { name: 'taylorForward', why: 'forward term summation instead of Horner', edits: cw('for (let k = 12; k >= 1; k--) p = 1 - (r * p) / k;', '{ let t = 1; for (let k = 1; k <= 12; k++) { t = (-r * t) / k; p += t; } }') },
  { name: 'scale512', why: 'x / 512 with 9 squarings', edits: [...cw('const r = x / 1024;', 'const r = x / 512;'), ...cw('for (let i = 0; i < 10; i++) p = p * p;', 'for (let i = 0; i < 9; i++) p = p * p;')] },
  // Level quantisation and derived values.
  { name: 'levelTruncate', why: 'floor(level * 1e6) without + 0.5', edits: cw('Math.floor(level * MICRO + 0.5)', 'Math.floor(level * MICRO)') },
  { name: 'scaleTruncate', why: 'labelFade / dust truncated instead of rounded half up', edits: cw('Math.floor((levelM * maxMicro + MICRO / 2) / MICRO)', 'Math.floor((levelM * maxMicro) / MICRO)') },
  { name: 'scaleFromDouble', why: 'labelFade = round(level * 0.35 * 1e6) via doubles', edits: cw('Math.floor((levelM * maxMicro + MICRO / 2) / MICRO)', 'Math.floor((levelM / MICRO) * (maxMicro / MICRO) * MICRO + 0.5)') },
  { name: 'revealRound', why: 'round instead of floor for the scratch count', edits: cw('Math.floor((levelM * max) / MICRO)', 'Math.round((levelM * max) / MICRO)') },
  // Safe zone clearance.
  { name: 'clearanceLt', why: '< instead of <= (touching counts as a hit)', edits: cw('if (dx * dx + dy * dy <= reach * reach) return true;', 'if (dx * dx + dy * dy < reach * reach) return true;') },
  { name: 'marginOnce', why: 'reach = d + margin', edits: cw('const reach = d + 2 * margin;', 'const reach = d + margin;') },
  { name: 'margin4999', why: 'margin off by one', edits: [{ file: 'config.ts', find: 'SAFE_ZONE_MARGIN_MICRO: 5_000,', replace: 'SAFE_ZONE_MARGIN_MICRO: 4_999,' }] },
  { name: 'margin5001', why: 'margin off by one', edits: [{ file: 'config.ts', find: 'SAFE_ZONE_MARGIN_MICRO: 5_000,', replace: 'SAFE_ZONE_MARGIN_MICRO: 5_001,' }] },
  { name: 'margin0', why: 'margin forgotten', edits: [{ file: 'config.ts', find: 'SAFE_ZONE_MARGIN_MICRO: 5_000,', replace: 'SAFE_ZONE_MARGIN_MICRO: 0,' }] },
  { name: 'notDoubled', why: 'dx, dy not doubled', edits: [...cw('const dx = 2 * Math.max(', 'const dx = Math.max('), ...cw('const dy = 2 * Math.max(', 'const dy = Math.max(')] },
  // Zone edge rounding.
  { name: 'x0Round', why: 'round instead of floor on x0', edits: cw('x0: Math.floor(x * MICRO),', 'x0: Math.round(x * MICRO),') },
  { name: 'y0Round', why: 'round instead of floor on y0', edits: cw('y0: Math.floor(y * MICRO),', 'y0: Math.round(y * MICRO),') },
  { name: 'x1Round', why: 'round instead of ceil on x1', edits: cw('x1: Math.ceil((x + w) * MICRO),', 'x1: Math.round((x + w) * MICRO),') },
  { name: 'y1Round', why: 'round instead of ceil on y1', edits: cw('y1: Math.ceil((y + h) * MICRO),', 'y1: Math.round((y + h) * MICRO),') },
  { name: 'x1Floor', why: 'floor instead of ceil on x1', edits: cw('x1: Math.ceil((x + w) * MICRO),', 'x1: Math.floor((x + w) * MICRO),') },
  { name: 'y1Floor', why: 'floor instead of ceil on y1', edits: cw('y1: Math.ceil((y + h) * MICRO),', 'y1: Math.floor((y + h) * MICRO),') },
  { name: 'x1CeilSum', why: 'ceil(x) + ceil(w) instead of ceil(x + w)', edits: cw('x1: Math.ceil((x + w) * MICRO),', 'x1: Math.ceil(x * MICRO) + Math.ceil(w * MICRO),') },
  { name: 'y1CeilSum', why: 'ceil(y) + ceil(h) instead of ceil(y + h)', edits: cw('y1: Math.ceil((y + h) * MICRO),', 'y1: Math.ceil(y * MICRO) + Math.ceil(h * MICRO),') },
  { name: 'x1FloorSum', why: 'floor(x) + ceil(w)', edits: cw('x1: Math.ceil((x + w) * MICRO),', 'x1: Math.floor(x * MICRO) + Math.ceil(w * MICRO),') },
  { name: 'x0Minus1', why: 'x0 one micro too far out', edits: cw('x0: Math.floor(x * MICRO),', 'x0: Math.floor(x * MICRO) - 1,') },
  { name: 'y0Minus1', why: 'y0 one micro too far out', edits: cw('y0: Math.floor(y * MICRO),', 'y0: Math.floor(y * MICRO) - 1,') },
  { name: 'x1Plus1', why: 'x1 one micro too far out', edits: cw('x1: Math.ceil((x + w) * MICRO),', 'x1: Math.ceil((x + w) * MICRO) + 1,') },
  { name: 'y1Plus1', why: 'y1 one micro too far out', edits: cw('y1: Math.ceil((y + h) * MICRO),', 'y1: Math.ceil((y + h) * MICRO) + 1,') },
  // Stream layout and draws.
  { name: 'breakOnAccept', why: 'stop drawing a slot once a candidate is accepted', edits: cw('chosen = { surface, x, y, angle, length, depth };', 'chosen = { surface, x, y, angle, length, depth };\n        break;') },
  { name: 'scuffBreakOnAccept', why: 'same, for scuffs', edits: cw('chosen = { surface, x, y, radius, intensity };', 'chosen = { surface, x, y, radius, intensity };\n        break;') },
  { name: 'halfFloor', why: 'floor(length / 2) instead of ceil', edits: cw('const half = Math.floor((length + 1) / 2);', 'const half = Math.floor(length / 2);') },
  { name: 'drawFloat32', why: 'u / 2^32 instead of (u >> 8) / 2^24', edits: cw('return lo + Math.floor(((u >>> 8) * (hi - lo)) / TWO_POW_24);', 'return lo + Math.floor((u / 4294967296) * (hi - lo));') },
  { name: 'drawXYSwapped', why: 'y drawn before x', edits: cw('      const x = drawMicro(rng.nextU32(), pos);\n      const y = drawMicro(rng.nextU32(), pos);\n      const depth', '      const y = drawMicro(rng.nextU32(), pos);\n      const x = drawMicro(rng.nextU32(), pos);\n      const depth') },
  { name: 'scuffsFirst', why: 'scuff slots drawn before scratch slots', edits: cw('  const scratchSeq = scratchSlots(rng, cfg, zones);\n  const scuffSeq = scuffSlots(rng, cfg, zones);', '  const scuffSeq = scuffSlots(rng, cfg, zones);\n  const scratchSeq = scratchSlots(rng, cfg, zones);') },
  { name: 'noEdgeInset', why: 'centre drawn without the edge inset', edits: cw('const pos: MicroRange = [r.edgeInset + half, MICRO - r.edgeInset - half];', 'const pos: MicroRange = [half, MICRO - half];') },
  // PRNG and seed.
  { name: 'seedLittleEndian', why: 'seed words parsed little endian', edits: [{ file: 'prng.ts', find: "parseInt(hex.slice(i * 8, i * 8 + 8), 16)", replace: "parseInt(hex.slice(i * 8, i * 8 + 8).match(/../g)!.reverse().join(''), 16)" }] },
  { name: 'seedNoMix', why: 'fmix32 skipped', edits: [{ file: 'prng.ts', find: 'return fmix32((w ^ Math.imul(GOLDEN, i + 1)) >>> 0);', replace: 'return (w ^ Math.imul(GOLDEN, i + 1)) >>> 0;' }] },
  { name: 'seedFallbackOne', why: 'all zero state fallback s0 = 1', edits: [{ file: 'prng.ts', find: 's[0] = GOLDEN;', replace: 's[0] = 1;' }] },
  { name: 'seedCaseSensitive', why: 'upper case seeds rejected', edits: [{ file: 'prng.ts', find: 'const SEED_RE = /^[0-9a-fA-F]{32}$/;', replace: 'const SEED_RE = /^[0-9a-f]{32}$/;' }] },
  { name: 'seedUnicodeDigits', why: 'any Unicode decimal digit accepted', edits: [{ file: 'prng.ts', find: 'const SEED_RE = /^[0-9a-fA-F]{32}$/;', replace: 'const SEED_RE = /^[\\p{Nd}a-fA-F]{32}$/u;' }] },
  { name: 'seedTrailingNewline', why: 'regex end anchor that allows a trailing newline', edits: [{ file: 'prng.ts', find: 'const SEED_RE = /^[0-9a-fA-F]{32}$/;', replace: 'const SEED_RE = /^[0-9a-fA-F]{32}\\n?$/;' }] },
  // Validation.
  { name: 'versionTruncate', why: 'version truncated to an integer', edits: cw('const cfg = getWearConfig(version);', 'const cfg = getWearConfig(Math.trunc(version));') },
  { name: 'rejectNegZero', why: '-0 rejected', edits: cw("if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {\n      throw new RangeError(`wearStats.", "if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || Object.is(v, -0)) {\n      throw new RangeError(`wearStats.") },
  { name: 'clampNegative', why: 'negative stats clamped to 0', edits: cw("if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {\n      throw new RangeError(`wearStats.", "if (v < 0) snap[k] = 0;\n    else if (typeof v !== 'number' || !Number.isFinite(v)) {\n      throw new RangeError(`wearStats.") },
  { name: 'zonesNullAsNone', why: 'wearSafeZones: null treated as no zones', edits: cw('if (zones === undefined) return [];', 'if (zones == null) return [];') },
  { name: 'zonesSkipBad', why: 'malformed zone entries skipped', edits: cw("if (z === null || typeof z !== 'object') throw new TypeError(`wearSafeZones[${i}] must be ${ZONE_SHAPE}`);", "if (z === null || typeof z !== 'object') continue;") },
  { name: 'zonesNoUpperBound', why: 'zone numbers above 1 accepted', edits: cw("return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;", "return typeof v === 'number' && Number.isFinite(v) && v >= 0;") },
  { name: 'zonesSumBound', why: 'x + w > 1 rejected', edits: cw('    // Closed rectangle', "    if ((x as number) + (w as number) > 1 || (y as number) + (h as number) > 1) throw new RangeError('wearSafeZones: zone past the edge');\n    // Closed rectangle") },
  // Serialisation.
  { name: 'noZeroPad', why: 'fraction not zero padded', edits: [{ file: 'serialize.ts', find: "String(m % MICRO).padStart(6, '0')", replace: 'String(m % MICRO)' }] },
];

/**
 * Deliberately NOT run: rewrites that are provably exact under IEEE 754, so no
 * vector can tell them apart and a port may use them freely.
 */
export const EQUIVALENT: Array<{ name: string; why: string }> = [
  { name: 'swap operands of one + or *', why: 'IEEE addition and multiplication are commutative: a + b == b + a bit for bit. Only regrouping changes results.' },
  { name: 'Math.round(level * 1e6)', why: 'differs from floor(v + 0.5) only at v = 0.5 - 2^-54; v = level * 1e6 sits on a grid about 1e-10 wide near there, which cannot hit that one double.' },
  { name: 'floor((u >> 8) / 2^24 * span)', why: 'the product of a 24 bit and a <= 28 bit integer is exact in a double, so it equals the integer form.' },
  { name: 'floor(level * 40) on the double level', why: 'checked exhaustively for all 1,000,001 levelMicro values and both maxima (40, 12): identical. test/computeWear.test.ts repeats the check.' },
  { name: 'Taylor to k = 11 or k = 16', why: 'the dropped or added terms are below 7e-24, under half an ulp of p; 0 of 2,000,000 random x in [0, 64) change expNeg.' },
  { name: 'r * p * (1 / k) in the Horner step', why: 'differs from (r * p) / k only for x > 15 (0 of 5,000,000 random x in [0, 15]); there level is 1 - exp(-x) >= 1 - 3.1e-7 and rounds to 1.000000 either way.' },
];

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const VECTORS = fileURLToPath(new URL('../wear-vectors.json', import.meta.url));

type WearModule = typeof import('../src/index');

function applyEdits(dir: string, m: Mutant): void {
  for (const e of m.edits) {
    const p = join(dir, e.file);
    const text = readFileSync(p, 'utf8');
    const count = text.split(e.find).length - 1;
    if (count !== 1) throw new Error(`mutant ${m.name}: edit matched ${count} times in ${e.file}`);
    writeFileSync(p, text.replace(e.find, () => e.replace));
  }
}

/** Imports a copy of src/ with the mutant's edits applied (or unmutated for null). */
export async function loadVariant(m: Mutant | null): Promise<{ mod: WearModule; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `wear-mutant-${m?.name ?? 'baseline'}-`));
  for (const f of readdirSync(SRC)) if (f.endsWith('.ts')) copyFileSync(join(SRC, f), join(dir, f));
  if (m) applyEdits(dir, m);
  const mod = (await import(pathToFileURL(join(dir, 'index.ts')).href)) as WearModule;
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Names of the vectors a module fails. */
export function failingVectors(mod: WearModule, file: WearVectorFile): string[] {
  const failed: string[] = [];
  for (const c of file.cases) {
    let ok: boolean;
    try {
      const d = mod.computeWear(c.input.seed, c.input.stats, c.input.version, { wearSafeZones: c.input.wearSafeZones as never });
      ok = c.expectedError === undefined && mod.serializeDescriptor(d) === c.expected;
    } catch (e) {
      ok = c.expectedError !== undefined && e instanceof Error && e.message.includes(c.expectedError);
    }
    if (!ok) failed.push(c.name);
  }
  return failed;
}

export interface MutantResult {
  name: string;
  killedBy: string[];
}

export async function runMutants(file: WearVectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'))): Promise<{
  baselineFailures: string[];
  results: MutantResult[];
}> {
  const base = await loadVariant(null);
  const baselineFailures = failingVectors(base.mod, file);
  base.cleanup();
  const results: MutantResult[] = [];
  for (const m of MUTANTS) {
    const v = await loadVariant(m);
    try {
      results.push({ name: m.name, killedBy: failingVectors(v.mod, file) });
    } finally {
      v.cleanup();
    }
  }
  return { baselineFailures, results };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { baselineFailures, results } = await runMutants();
  if (baselineFailures.length > 0) console.log(`BASELINE FAILS ${baselineFailures.length} vectors: ${baselineFailures.slice(0, 5).join(' | ')}`);
  for (const r of results) {
    console.log(`${r.killedBy.length > 0 ? 'killed  ' : 'SURVIVED'} ${r.name.padEnd(22)} ${r.killedBy.length} vectors  ${r.killedBy.slice(0, 3).join(' | ')}`);
  }
  const survivors = results.filter((r) => r.killedBy.length === 0);
  console.log(`\n${results.length} mutants, ${results.length - survivors.length} killed, ${survivors.length} survived`);
  process.exit(baselineFailures.length > 0 || survivors.length > 0 ? 1 : 0);
}
