import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { MovementSystem } from '../src/game/MovementSystem';

describe('MovementSystem - open world (ignoreWorldBounds)', () => {
  it('does not clamp X/Y/Z when ignoreWorldBounds=true even if worldBounds are set', () => {
    const bus = new EventBus();
    const state = {
      players: {
        A: { id: 'A', position: { x: 0, y: 0, z: 0 }, velocity: { x: 10000, y: 10000, z: 10000 } },
      },
      inventories: {},
      objects: {},
      tick: 0,
    } as any;

    const ms = new MovementSystem(bus, () => state, {
      smoothing: 1,
      extrapolationMs: 1000,
      worldBounds: { width: 10, height: 10, depth: 20 },
      ignoreWorldBounds: true,
      maxSpeed: 50,
    });

    bus.emit('playerMove', 'A');
    const t0 = performance.now();
    ms.interpolate(t0 + 1000); // 1s of allowed dt at smoothing=1 and maxSpeed=50 → delta 50 on each axis

    expect(state.players.A.position.x).toBe(50);
    expect(state.players.A.position.y).toBe(50);
    expect(state.players.A.position.z).toBe(50);
  });
});


