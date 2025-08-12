import { describe, it, expect, vi } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { NetMessage } from '../src/types';

function makeSM() {
  const bus = new EventBus();
  const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'ME');
  return { bus, sm };
}

describe('StateManager events', () => {
  it('emits playerMove/inventoryUpdate/objectTransfer/stateSync/stateDelta/sharedPayload', () => {
    const { bus, sm } = makeSM();
    const seen: string[] = [];
    bus.on('playerMove', () => seen.push('move'));
    bus.on('inventoryUpdate', () => seen.push('inv'));
    bus.on('objectTransfer', () => seen.push('xfer'));
    bus.on('stateSync', () => seen.push('full'));
    bus.on('stateDelta', () => seen.push('delta'));
    bus.on('sharedPayload', () => seen.push('shared'));

    const full: NetMessage = { t: 'state_full', from: 'H', ts: 1, state: { players: {}, inventories: {}, objects: {}, tick: 0 } } as any;
    sm.handleNetMessage(full);
    const delta: NetMessage = { t: 'state_delta', from: 'H', ts: 2, delta: { tick: 1, changes: [{ path: 'objects.obj', value: { id: 'o', kind: 'k', data: {} } }] } } as any;
    sm.handleNetMessage(delta);
    const mov: NetMessage = { t: 'move', from: 'P', ts: 3, seq: 1, position: { x: 1, y: 2 } } as any;
    sm.handleNetMessage(mov);
    const inv: NetMessage = { t: 'inventory', from: 'P', ts: 4, seq: 2, items: [] } as any;
    sm.handleNetMessage(inv);
    // Seed inventory to allow transfer
    sm.getState().inventories['P'] = [{ id: 'potion', type: 'heal', quantity: 1 }];
    const xfer: NetMessage = { t: 'transfer', from: 'P', ts: 5, seq: 3, to: 'Q', item: { id: 'potion', type: 'heal', quantity: 1 } } as any;
    sm.handleNetMessage(xfer);

    const shared: NetMessage = { t: 'payload', from: 'P', ts: 6, seq: 4, payload: { hp: 42 }, channel: 'status' } as any;
    sm.handleNetMessage(shared);

    expect(seen).toEqual(['full','delta','move','inv','xfer','shared']);
  });

  it('buildDeltaFromPaths constructs value snapshots', () => {
    const { sm } = makeSM();
    const st = sm.getState();
    (st as any).players['A'] = { id: 'A', position: { x: 1, y: 2 } };
    const delta = sm.buildDeltaFromPaths(['players.A.position']);
    expect(delta.changes[0]).toEqual({ path: 'players.A.position', value: { x: 1, y: 2 } });
  });

  it('setPathsValues mutates local state (no network)', () => {
    const { sm } = makeSM();
    sm.setPathsValues([{ path: 'objects.status.A', value: { id: 'status.A', kind: 'playerStatus', data: { hp: 10 } } }]);
    expect((sm.getState() as any).objects.status.A.data.hp).toBe(10);
  });
});


