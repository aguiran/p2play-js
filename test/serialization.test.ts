import { describe, it, expect } from 'vitest';
import { createSerializer } from '../src/net/serialization';

const sample = { t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 1, y: 2 } } as any;

describe('serialization', () => {
  it('json encode/decode roundtrip', () => {
    const s = createSerializer('json');
    const enc = s.encode(sample);
    expect(typeof enc).toBe('string');
    const dec = s.decode(enc as string);
    expect(dec).toEqual(sample);
  });
  it('binary-min encode/decode roundtrip', () => {
    const s = createSerializer('binary-min');
    const enc = s.encode(sample);
    expect(enc instanceof ArrayBuffer).toBe(true);
    const dec = s.decode(enc as ArrayBuffer);
    expect(dec).toEqual(sample);
  });
  it('throws on unknown strategy', () => {
    // @ts-expect-error: testing invalid strategy
    expect(() => createSerializer('unknown')).toThrowError();
  });
});


