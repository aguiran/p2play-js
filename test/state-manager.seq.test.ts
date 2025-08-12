import { describe, it, expect } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { NetMessage } from '../src/types';

function makeSM() {
  const bus = new EventBus();
  return new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'ME');
}

describe('StateManager seq handling', () => {
  it('accepts equal ts but higher seq only', () => {
    const sm = makeSM();
    const a: NetMessage = { t: 'move', from: 'P', ts: 1, seq: 1, position: { x: 1, y: 1 } } as any;
    const b: NetMessage = { t: 'move', from: 'P', ts: 1, seq: 2, position: { x: 2, y: 2 } } as any;
    sm.handleNetMessage(a);
    sm.handleNetMessage(b);
    sm.handleNetMessage(a); // stale
    expect(sm.getState().players['P'].position).toEqual({ x: 2, y: 2 });
  });
});


