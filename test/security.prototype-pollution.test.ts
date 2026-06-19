import { describe, it, expect } from 'vitest';
import { StateManager } from '../src/sync/StateManager';
import { EventBus } from '../src/events/EventBus';
import { getAtPath, setAtPath } from '../src/sync/pathUtils';
import { NetMessage } from '../src/types';

describe('prototype pollution hardening', () => {
  it('setAtPath ignores __proto__ paths and does not pollute Object.prototype', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, '__proto__.polluted', true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('setAtPath ignores constructor.prototype paths', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, 'constructor.prototype.polluted', true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('setAtPath still writes safe nested paths', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, 'a.b.c', 42);
    expect(target).toEqual({ a: { b: { c: 42 } } });
  });

  it('getAtPath refuses to traverse forbidden segments', () => {
    expect(getAtPath({}, '__proto__.x')).toBeUndefined();
    expect(getAtPath({}, 'constructor.name')).toBeUndefined();
  });

  it('a malicious state_delta cannot pollute the prototype chain', () => {
    const bus = new EventBus();
    const sm = new StateManager(bus, 'timestamp', () => 'LOCAL');
    const evil: NetMessage = {
      t: 'state_delta',
      from: 'ATTACKER',
      ts: 1,
      delta: { tick: 1, changes: [{ path: '__proto__.polluted', value: true }] },
    } as unknown as NetMessage;
    sm.handleNetMessage(evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
