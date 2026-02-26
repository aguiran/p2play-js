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

  it('resolveMove returns false for non-move message', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    expect(r.resolveMove(st, { t: 'inventory', from: 'A', ts: 1, items: [] } as any)).toBe(false);
  });

  it('resolveInventory returns false for non-inventory message', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    expect(r.resolveInventory(st, { t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 } } as any)).toBe(false);
  });

  it('resolveTransfer returns false for non-transfer message', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    expect(r.resolveTransfer(st, { t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 } } as any)).toBe(false);
  });

  it('transfer adds quantity to existing item in target inventory', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    st.inventories['A'] = [{ id: 'potion', type: 'heal', quantity: 3 }];
    st.inventories['B'] = [{ id: 'potion', type: 'heal', quantity: 2 }];
    const msg: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 1, seq: 1, item: { id: 'potion', type: 'heal', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, msg)).toBe(true);
    expect(st.inventories['A'][0].quantity).toBe(2);
    expect(st.inventories['B'][0].quantity).toBe(3);
  });

  it('resolveMove applies position without velocity', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 5, y: 10 } } as any;
    expect(r.resolveMove(st, msg)).toBe(true);
    expect(st.players['A'].position).toEqual({ x: 5, y: 10 });
    expect(st.players['A'].velocity).toBeUndefined();
  });

  it('authoritative mode accepts move from authoritative sender', () => {
    const r = new ConflictResolver('authoritative', () => 'HOST', () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'move', from: 'HOST', ts: 1, position: { x: 1, y: 1 } } as any;
    expect(r.resolveMove(st, msg)).toBe(true);
    expect(st.players['HOST'].position).toEqual({ x: 1, y: 1 });
  });

  it('authoritative mode accepts inventory from authoritative sender', () => {
    const r = new ConflictResolver('authoritative', () => 'HOST', () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'inventory', from: 'HOST', ts: 1, items: [{ id: 'x', type: 't', quantity: 1 }] } as any;
    expect(r.resolveInventory(st, msg)).toBe(true);
    expect(st.inventories['HOST']).toHaveLength(1);
  });

  it('authoritative mode accepts transfer from authoritative sender', () => {
    const r = new ConflictResolver('authoritative', () => 'HOST', () => []);
    const st = baseState();
    st.inventories['HOST'] = [{ id: 'p', type: 't', quantity: 5 }];
    const msg: NetMessage = { t: 'transfer', from: 'HOST', to: 'B', ts: 1, item: { id: 'p', type: 't', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, msg)).toBe(true);
    expect(st.inventories['HOST'][0].quantity).toBe(4);
  });

  it('resolveMove applies both position and velocity', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 5, y: 10 }, velocity: { x: 1, y: 2 } } as any;
    expect(r.resolveMove(st, msg)).toBe(true);
    expect(st.players['A'].position).toEqual({ x: 5, y: 10 });
    expect(st.players['A'].velocity).toEqual({ x: 1, y: 2 });
  });

  it('transfer fails when source has no inventory', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 1, item: { id: 'p', type: 't', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, msg)).toBe(false);
  });

  it('transfer removes item from source when quantity reaches zero', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    st.inventories['A'] = [{ id: 'potion', type: 'heal', quantity: 1 }];
    const msg: NetMessage = { t: 'transfer', from: 'A', to: 'B', ts: 1, item: { id: 'potion', type: 'heal', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, msg)).toBe(true);
    expect(st.inventories['A']).toEqual([]);
    expect(st.inventories['B']).toEqual([{ id: 'potion', type: 'heal', quantity: 1 }]);
  });

  it('authoritative mode with undefined auth allows all messages', () => {
    const r = new ConflictResolver('authoritative', () => undefined, () => []);
    const st = baseState();
    expect(r.resolveMove(st, { t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 } } as any)).toBe(true);
    expect(r.resolveInventory(st, { t: 'inventory', from: 'A', ts: 1, items: [] } as any)).toBe(true);
    st.inventories['A'] = [{ id: 'p', type: 't', quantity: 5 }];
    expect(r.resolveTransfer(st, { t: 'transfer', from: 'A', to: 'B', ts: 1, item: { id: 'p', type: 't', quantity: 1 } } as any)).toBe(true);
  });
});


