import { describe, expect, it } from 'vitest';
import { computeWear } from '../src/computeWear';
import { formatMicro, serializeDescriptor } from '../src/serialize';

const SEED = 'fedcba9876543210fedcba9876543210';

describe('serializeDescriptor (canonical JSON)', () => {
  it('uses fixed key order, no whitespace, six fixed decimals and an integer version', () => {
    const s = serializeDescriptor(computeWear(SEED, { playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1));
    expect(s).toBe(
      `{"version":1,"seed":"${SEED}","level":0.000000,"scratches":[],"scuffZones":[],` +
        '"labelFade":0.000000,"edgeWear":0.000000,"dustAmount":0.000000}',
    );
  });

  it('orders scratch and scuff keys canonically and parses back to the same values', () => {
    const d = computeWear(SEED, { playSeconds: 180 * 400, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1);
    const s = serializeDescriptor(d);
    expect(s).toMatch(/^\{"version":1,"seed":"[0-9a-f]{32}","level":\d\.\d{6},"scratches":\[/);
    expect(s).toContain('{"surface":"');
    expect(s).toMatch(/\{"surface":"(shell|window|label|disc)","x":\d\.\d{6},"y":\d\.\d{6},"angle":\d+\.\d{6},"length":\d\.\d{6},"depth":\d\.\d{6}\}/);
    expect(s).toMatch(/\{"surface":"(shell|window|label|disc)","x":\d\.\d{6},"y":\d\.\d{6},"radius":\d\.\d{6},"intensity":\d\.\d{6}\}/);
    expect(s).not.toMatch(/\s/);
    expect(JSON.parse(s)).toEqual(d);
  });

  it('ignores key order and extra keys on the input object', () => {
    const d = computeWear(SEED, { playSeconds: 180 * 50, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1);
    const shuffled = { extra: 1, ...Object.fromEntries(Object.entries(d).reverse()) } as unknown as typeof d;
    expect(Object.keys(shuffled)[1]).toBe('dustAmount');
    expect(serializeDescriptor(shuffled)).toBe(serializeDescriptor(d));
  });

  it('formatMicro renders micro units as fixed six decimal strings', () => {
    expect(formatMicro(0)).toBe('0.000000');
    expect(formatMicro(1)).toBe('0.000001');
    expect(formatMicro(350_000)).toBe('0.350000');
    expect(formatMicro(1_000_000)).toBe('1.000000');
    expect(formatMicro(179_999_999)).toBe('179.999999');
    expect(() => formatMicro(-1)).toThrow();
    expect(() => formatMicro(0.5)).toThrow();
  });

  it('refuses values that are not on the 1e-6 grid or are negative', () => {
    const d = computeWear(SEED, { playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1);
    expect(() => serializeDescriptor({ ...d, level: 0.1234567 })).toThrow();
    expect(() => serializeDescriptor({ ...d, level: -0.1 })).toThrow();
    expect(() => serializeDescriptor({ ...d, seed: 'not"hex' })).toThrow();
  });
});
