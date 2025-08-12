import { describe, it, expect } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { NetMessage } from '../src/types';

function makeSM(localId = 'ME') {
  const bus = new EventBus();
  const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => localId);
  return sm;
}

describe('StateManager full state merging', () => {
  it('merges full state without overwriting existing local player unless initial', () => {
    const sm = makeSM('L');
    // Seed local state and mark seq for local to avoid initial-join override path
    sm.handleNetMessage({ t: 'move', from: 'L', ts: 0, seq: 1, position: { x: 100, y: 100 } } as any);
    const incoming: NetMessage = {
      t: 'state_full', from: 'H', ts: 1,
      state: {
        players: { L: { id: 'L', position: { x: 0, y: 0 } }, R: { id: 'R', position: { x: 5, y: 6 } } },
        inventories: { R: [] },
        objects: {},
        tick: 10
      }
    } as any;
    sm.handleNetMessage(incoming);
    // Local position kept, remote added
    expect(sm.getState().players['L'].position).toEqual({ x: 100, y: 100 });
    expect(sm.getState().players['R'].position).toEqual({ x: 5, y: 6 });
    expect(sm.getState().tick).toBe(10);
  });

  it('accepts host snapshot for local player on initial join (no seq)', () => {
    const sm = makeSM('L');
    const incoming: NetMessage = {
      t: 'state_full', from: 'H', ts: 1,
      state: {
        players: { L: { id: 'L', position: { x: 1, y: 2 } } },
        inventories: { L: [{ id: 'p', type: 't', quantity: 1 }] },
        objects: {},
        tick: 2
      }
    } as any;
    sm.handleNetMessage(incoming);
    expect(sm.getState().players['L'].position).toEqual({ x: 1, y: 2 });
    expect(sm.getState().inventories['L']).toEqual([{ id: 'p', type: 't', quantity: 1 }]);
  });
});


