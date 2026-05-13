import { describe, it, expect } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { NetMessage } from '../src/types';

function makeStateManager(mode: 'timestamp' = 'timestamp') {
  const bus = new EventBus();
  return new StateManager(bus, mode, () => 'LOCAL');
}

describe('StateManager', () => {
  it('applies full state and delta', () => {
    const sm = makeStateManager();
    const full: NetMessage = { t: 'state_full', from: 'H', ts: 1, state: { players: { A: { id: 'A', position: { x: 1, y: 1 } } }, inventories: {}, objects: {}, tick: 0 } } as any;
    sm.handleNetMessage(full);
    expect(sm.getState().players['A'].position).toEqual({ x: 1, y: 1 });
    const delta: NetMessage = { t: 'state_delta', from: 'H', ts: 2, delta: { tick: 1, changes: [{ path: 'players.A.position', value: { x: 5, y: 6 } }] } } as any;
    sm.handleNetMessage(delta);
    expect(sm.getState().players['A'].position).toEqual({ x: 5, y: 6 });
  });

  it('drops stale seq', () => {
    const sm = makeStateManager();
    const m1: NetMessage = { t: 'move', from: 'P1', ts: 1, seq: 2, position: { x: 2, y: 2 } } as any;
    const m2: NetMessage = { t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 1, y: 1 } } as any;
    sm.handleNetMessage(m1);
    sm.handleNetMessage(m2);
    expect(sm.getState().players['P1'].position).toEqual({ x: 2, y: 2 });
  });

  it('applies inventory snapshots for non-local peers in full state', () => {
    const sm = makeStateManager();
    const full: NetMessage = {
      t: 'state_full',
      from: 'HOST',
      ts: 1,
      state: {
        players: {
          LOCAL: { id: 'LOCAL', position: { x: 0, y: 0 } },
          P2: { id: 'P2', position: { x: 3, y: 4 } },
        },
        inventories: {
          LOCAL: [{ id: 'local-item', type: 'debug', quantity: 1 }],
          P2: [{ id: 'potion', type: 'heal', quantity: 2 }],
        },
        objects: {},
        tick: 3,
      },
    } as any;

    sm.handleNetMessage(full);
    expect(sm.getState().inventories.P2).toEqual([{ id: 'potion', type: 'heal', quantity: 2 }]);
  });

  it('does not emit move/inventory/transfer when resolver rejects', () => {
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    let moveFired = false;
    let invFired = false;
    let transferFired = false;
    bus.on('playerMove', () => { moveFired = true; });
    bus.on('inventoryUpdate', () => { invFired = true; });
    bus.on('objectTransfer', () => { transferFired = true; });

    const resolver = (sm as any).resolver;
    resolver.resolveMove = () => false;
    resolver.resolveInventory = () => false;
    resolver.resolveTransfer = () => false;

    sm.handleNetMessage({ t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 99, y: 99 } } as any);
    sm.handleNetMessage({ t: 'inventory', from: 'P1', ts: 2, seq: 2, items: [{ id: 'potion', type: 'heal', quantity: 1 }] } as any);
    sm.handleNetMessage({ t: 'transfer', from: 'P1', to: 'P2', ts: 3, seq: 3, item: { id: 'potion', type: 'heal', quantity: 1 } } as any);

    expect(moveFired).toBe(false);
    expect(invFired).toBe(false);
    expect(transferFired).toBe(false);
  });
});

describe('StateManager consistency behavior', () => {
  it('accepts move from any sender', () => {
    const bus = new EventBus();
    let moveFired = false;
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    bus.on('playerMove', () => { moveFired = true; });
    sm.handleNetMessage({ t: 'move', from: 'RANDO', ts: 1, seq: 1, position: { x: 1, y: 2 } } as any);
    expect(moveFired).toBe(true);
  });

  it('accepts inventory from any sender', () => {
    const bus = new EventBus();
    let invFired = false;
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    bus.on('inventoryUpdate', () => { invFired = true; });
    sm.handleNetMessage({ t: 'inventory', from: 'RANDO', ts: 1, seq: 1, items: [{ id: 'x', type: 't', quantity: 1 }] } as any);
    expect(invFired).toBe(true);
  });

  it('accepts transfer from any sender', () => {
    const bus = new EventBus();
    let trFired = false;
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    bus.on('objectTransfer', () => { trFired = true; });
    sm.getState().inventories['RANDO'] = [{ id: 'p', type: 't', quantity: 5 }];
    sm.handleNetMessage({ t: 'transfer', from: 'RANDO', to: 'B', ts: 1, seq: 1, item: { id: 'p', type: 't', quantity: 1 } } as any);
    expect(trFired).toBe(true);
  });
});

describe('StateManager buildDeltaFromPaths', () => {
  it('returns undefined for nonexistent path', () => {
    const sm = makeStateManager();
    const delta = sm.buildDeltaFromPaths(['nonexistent.deep.path']);
    expect(delta.changes[0].value).toBeUndefined();
  });
});

describe('StateManager applyFullState with inventories', () => {
  it('merges remote player inventories', () => {
    const sm = makeStateManager();
    const full: NetMessage = {
      t: 'state_full', from: 'H', ts: 1,
      state: {
        players: { R: { id: 'R', position: { x: 1, y: 1 } } },
        inventories: { R: [{ id: 'sword', type: 'weapon', quantity: 1 }] },
        objects: {}, tick: 0
      }
    } as any;
    sm.handleNetMessage(full);
    expect(sm.getState().inventories['R']).toEqual([{ id: 'sword', type: 'weapon', quantity: 1 }]);
  });
});

describe('StateManager prepareForResync', () => {
  it('after prepareForResync, next state_full updates local player', () => {
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    // Set initial local state
    sm.handleNetMessage({
      t: 'state_full', from: 'H', ts: 1,
      state: {
        players: { LOCAL: { id: 'LOCAL', position: { x: 10, y: 10 } } },
        inventories: {},
        objects: {},
        tick: 0
      }
    } as any);
    expect(sm.getState().players['LOCAL'].position).toEqual({ x: 10, y: 10 });
    // Apply a move from LOCAL so lastAppliedSeq has LOCAL
    sm.handleNetMessage({ t: 'move', from: 'LOCAL', ts: 2, seq: 1, position: { x: 20, y: 20 } } as any);
    // Host sends state_full with LOCAL at (5,5) - normally we skip local overwrite
    sm.handleNetMessage({
      t: 'state_full', from: 'H', ts: 3,
      state: {
        players: { LOCAL: { id: 'LOCAL', position: { x: 5, y: 5 } } },
        inventories: {},
        objects: {},
        tick: 1
      }
    } as any);
    expect(sm.getState().players['LOCAL'].position).toEqual({ x: 20, y: 20 }); // unchanged
    // Reconnect: prepare for resync
    sm.prepareForResync();
    // Next state_full should overwrite local
    sm.handleNetMessage({
      t: 'state_full', from: 'H', ts: 4,
      state: {
        players: { LOCAL: { id: 'LOCAL', position: { x: 99, y: 99 } } },
        inventories: {},
        objects: {},
        tick: 2
      }
    } as any);
    expect(sm.getState().players['LOCAL'].position).toEqual({ x: 99, y: 99 });
  });
});

