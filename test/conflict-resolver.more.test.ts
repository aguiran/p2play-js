import { describe, it, expect } from 'vitest';
import { ConflictResolver } from '../src/sync/ConflictResolver';
import { GlobalGameState, NetMessage } from '../src/types';

function baseState(): GlobalGameState {
  return { players: {}, inventories: {}, objects: {}, tick: 0 };
}

describe('ConflictResolver.applyDelta & edge cases', () => {
  it('applies nested delta paths and keeps max tick', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    r.applyDelta(st, { tick: 3, changes: [{ path: 'objects.foo.bar', value: 42 }] });
    expect((st.objects as any).foo.bar).toBe(42);
    expect(st.tick).toBe(3);
    r.applyDelta(st, { tick: 1, changes: [{ path: 'objects.foo.baz', value: 7 }] });
    expect((st.objects as any).foo.baz).toBe(7);
    // tick stays at max
    expect(st.tick).toBe(3);
  });

  it('transfer rejects when item not present or insufficient quantity', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    st.inventories['A'] = [{ id: 'potion', type: 'heal', quantity: 1 }];
    // wrong item id
    const badId: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 1, seq: 1, item: { id: 'elixir', type: 'mana', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, badId)).toBe(false);
    // too large quantity
    const tooMuch: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 2, seq: 2, item: { id: 'potion', type: 'heal', quantity: 2 } } as any;
    expect(r.resolveTransfer(st, tooMuch)).toBe(false);
  });

  it('authoritative mode rejects inventory/transfer from non-host', () => {
    const r = new ConflictResolver('authoritative', () => 'HOST', () => []);
    const st = baseState();
    const inv: NetMessage = { t: 'inventory', from: 'A', ts: 1, seq: 1, items: [] } as any;
    expect(r.resolveInventory(st, inv)).toBe(false);
    const tr: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 2, seq: 1, item: { id: 'p', type: 't', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, tr)).toBe(false);
  });
});


