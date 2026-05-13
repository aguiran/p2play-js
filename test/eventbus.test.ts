import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/events/EventBus';

describe('EventBus', () => {
  it('should register, emit and remove listeners', () => {
    const bus = new EventBus();
    let calls = 0;
    const off = bus.on('peerJoin', () => { calls++; });
    bus.emit('peerJoin', 'P1' as any);
    expect(calls).toBe(1);
    off();
    bus.emit('peerJoin', 'P2' as any);
    expect(calls).toBe(1);
  });

  it('supports multiple listeners on the same event', () => {
    const bus = new EventBus();
    let a = 0, b = 0;
    bus.on('peerJoin', () => { a++; });
    bus.on('peerJoin', () => { b++; });
    bus.emit('peerJoin', 'P1' as any);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});


