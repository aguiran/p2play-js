import { describe, it, expect } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { NetMessage } from '../src/types';

function makeStateManager(mode: 'timestamp' | 'authoritative' = 'timestamp') {
  const bus = new EventBus();
  return new StateManager(bus, mode, () => undefined, () => [], () => 'LOCAL');
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
});


