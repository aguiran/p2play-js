import { describe, it, expect } from 'vitest';
import { MovementSystem } from '../src/game/MovementSystem';
import { EventBus } from '../src/events/EventBus';

describe('MovementSystem edge cases', () => {
  it('handles empty players gracefully', () => {
    const bus = new EventBus();
    const state = { players: {}, inventories: {}, objects: {}, tick: 0 } as any;
    const ms = new MovementSystem(bus, () => state, {});
    ms.interpolate(performance.now());
    ms.resolveCollisions();
    expect(Object.keys(state.players).length).toBe(0);
  });
});


