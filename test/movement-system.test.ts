import { describe, it, expect } from 'vitest';
import { MovementSystem } from '../src/game/MovementSystem';
import { EventBus } from '../src/events/EventBus';

describe('MovementSystem', () => {
  it('applies interpolation with smoothing and bounds', () => {
    const bus = new EventBus();
    const state = {
      players: {
        A: { id: 'A', position: { x: 0, y: 0, z: 0 }, velocity: { x: 100, y: 0, z: 0 } }
      }, inventories: {}, objects: {}, tick: 0
    } as any;
    const ms = new MovementSystem(bus, () => state, { smoothing: 1, extrapolationMs: 1000, worldBounds: { width: 10, height: 10, depth: 10 } });
    bus.emit('playerMove', 'A');
    const t = performance.now();
    ms.interpolate(t + 1000); // ~1s, v=100 -> x += 100 capped to bounds 10
    expect(state.players.A.position.x).toBe(10);
    expect(state.players.A.position.y).toBe(0);
  });

  it('resolves simple collisions by separating circles', () => {
    const bus = new EventBus();
    const state = {
      players: {
        A: { id: 'A', position: { x: 0, y: 0, z: 0 } },
        B: { id: 'B', position: { x: 10, y: 0, z: 0 } }
      }, inventories: {}, objects: {}, tick: 0
    } as any;
    const ms = new MovementSystem(bus, () => state, { playerRadius: 8 });
    ms.resolveCollisions();
    const ax = state.players.A.position.x;
    const bx = state.players.B.position.x;
    expect(bx - ax).toBeGreaterThanOrEqual(16);
  });
});


