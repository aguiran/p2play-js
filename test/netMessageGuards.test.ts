import { describe, it, expect, vi } from 'vitest';
import { isValidNetMessage } from '../src/net/netMessageGuards';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';

describe('isValidNetMessage', () => {
  it('accepts valid move message', () => {
    expect(isValidNetMessage({ t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 } })).toBe(true);
  });
  it('accepts valid inventory message', () => {
    expect(isValidNetMessage({ t: 'inventory', from: 'A', ts: 1, items: [] })).toBe(true);
  });
  it('accepts valid transfer message', () => {
    expect(isValidNetMessage({ t: 'transfer', from: 'A', ts: 1, to: 'B', item: { id: 'i1', type: 't', quantity: 1 } })).toBe(true);
  });
  it('accepts valid state_full message', () => {
    expect(isValidNetMessage({ t: 'state_full', from: 'H', ts: 1, state: { players: {}, inventories: {}, objects: {}, tick: 0 } })).toBe(true);
  });
  it('accepts valid state_delta message', () => {
    expect(isValidNetMessage({ t: 'state_delta', from: 'H', ts: 1, delta: { tick: 1, changes: [] } })).toBe(true);
  });
  it('accepts valid payload message', () => {
    expect(isValidNetMessage({ t: 'payload', from: 'A', ts: 1 })).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidNetMessage(null)).toBe(false);
  });
  it('rejects non-object', () => {
    expect(isValidNetMessage('string')).toBe(false);
    expect(isValidNetMessage(42)).toBe(false);
  });
  it('rejects missing t', () => {
    expect(isValidNetMessage({ from: 'A', ts: 1, position: { x: 0, y: 0 } })).toBe(false);
  });
  it('rejects missing from', () => {
    expect(isValidNetMessage({ t: 'move', ts: 1, position: { x: 0, y: 0 } })).toBe(false);
  });
  it('rejects missing ts', () => {
    expect(isValidNetMessage({ t: 'move', from: 'A', position: { x: 0, y: 0 } })).toBe(false);
  });
  it('rejects move without position', () => {
    expect(isValidNetMessage({ t: 'move', from: 'A', ts: 1 })).toBe(false);
  });
  it('rejects move with invalid position', () => {
    expect(isValidNetMessage({ t: 'move', from: 'A', ts: 1, position: { x: 0 } })).toBe(false);
  });
  it('rejects unknown t', () => {
    expect(isValidNetMessage({ t: 'unknown', from: 'A', ts: 1 })).toBe(false);
  });
  it('rejects transfer with item missing id', () => {
    expect(isValidNetMessage({ t: 'transfer', from: 'A', ts: 1, to: 'B', item: { type: 't', quantity: 1 } })).toBe(false);
  });
  it('rejects transfer with item missing quantity', () => {
    expect(isValidNetMessage({ t: 'transfer', from: 'A', ts: 1, to: 'B', item: { id: 'i1', type: 't' } })).toBe(false);
  });
});

describe('StateManager handleNetMessage with invalid messages', () => {
  it('does not crash and does not apply invalid message', () => {
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'LOCAL');
    let playerMoveCount = 0;
    bus.on('playerMove', () => { playerMoveCount++; });

    sm.handleNetMessage({} as any);
    sm.handleNetMessage({ t: 'move', from: 'A' } as any);
    sm.handleNetMessage({ t: 'move', from: 'A', ts: 1 } as any);

    expect(playerMoveCount).toBe(0);
    expect(sm.getState().players['A']).toBeUndefined();
  });

  it('still applies valid messages after invalid ones', () => {
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'LOCAL');
    sm.handleNetMessage({} as any);
    sm.handleNetMessage({ t: 'move', from: 'P1', ts: 1, seq: 1, position: { x: 10, y: 20 } } as any);
    expect(sm.getState().players['P1'].position).toEqual({ x: 10, y: 20 });
  });
});

describe('StateManager debug mode traces rejected messages', () => {
  it('calls console.debug when debug.enabled and message is rejected by guard', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'LOCAL', { enabled: true });

    sm.handleNetMessage({} as any);
    sm.handleNetMessage({ t: 'move', from: 'A' } as any);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('netMessage rejected');
    expect(spy.mock.calls[1][0]).toContain('netMessage rejected');
    spy.mockRestore();
  });

  it('does not call console.debug when debug is not enabled', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'LOCAL');

    sm.handleNetMessage({} as any);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('includes t and from fields in the debug output', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => undefined, () => [], () => 'LOCAL', { enabled: true });

    sm.handleNetMessage({ t: 'unknown_type', from: 'X', ts: 1 } as any);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ t: 'unknown_type', from: 'X' }));
    spy.mockRestore();
  });
});
