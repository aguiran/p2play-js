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
});


