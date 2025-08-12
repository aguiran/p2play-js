import { describe, it, expect } from 'vitest';
import { ConflictResolver } from '../src/sync/ConflictResolver';
import { GlobalGameState, NetMessage } from '../src/types';

function baseState(): GlobalGameState {
  return { players: {}, inventories: {}, objects: {}, tick: 0 };
}

describe('ConflictResolver', () => {
  it('accepts latest move in timestamp mode', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    const m1: NetMessage = { t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 1, y: 1 } } as any;
    const m2: NetMessage = { t: 'move', from: 'P1', ts: 2, seq: 2, position: { x: 2, y: 2 } } as any;
    expect(r.resolveMove(st, m1)).toBe(true);
    expect(st.players['P1'].position).toEqual({ x: 1, y: 1 });
    expect(r.resolveMove(st, m2)).toBe(true);
    expect(st.players['P1'].position).toEqual({ x: 2, y: 2 });
  });

  it('rejects non-authoritative in authoritative mode', () => {
    const r = new ConflictResolver('authoritative', () => 'HOST', () => []);
    const st = baseState();
    const msg: NetMessage = { t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 1, y: 1 } } as any;
    expect(r.resolveMove(st, msg)).toBe(false);
    expect(st.players['P1']).toBeUndefined();
  });

  it('inventory last-writer-wins', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    const upd: NetMessage = { t: 'inventory', from: 'P1', ts: 1, seq: 1, items: [{ id: 'potion', type: 'heal', quantity: 2 }] } as any;
    expect(r.resolveInventory(st, upd)).toBe(true);
    expect(st.inventories['P1']).toEqual([{ id: 'potion', type: 'heal', quantity: 2 }]);
  });

  it('transfer enforces quantities and moves items', () => {
    const r = new ConflictResolver('timestamp', () => undefined, () => []);
    const st = baseState();
    // seed inventory
    st.inventories['P1'] = [{ id: 'potion', type: 'heal', quantity: 2 }];
    const tr: NetMessage = { t: 'transfer', from: 'P1', to: 'P2', ts: 1, seq: 1, item: { id: 'potion', type: 'heal', quantity: 1 } } as any;
    expect(r.resolveTransfer(st, tr)).toBe(true);
    expect(st.inventories['P1']).toEqual([{ id: 'potion', type: 'heal', quantity: 1 }]);
    expect(st.inventories['P2']).toEqual([{ id: 'potion', type: 'heal', quantity: 1 }]);
  });
});


