import { describe, it, expect } from 'vitest';
import { MovementSystem } from '../src/game/MovementSystem';
import { EventBus } from '../src/events/EventBus';

describe('MovementSystem more branches', () => {
  it('does nothing without velocity and respects extrapolation cap', () => {
    const bus = new EventBus();
    const state = { players: { A: { id: 'A', position: { x: 0, y: 0 } } }, inventories: {}, objects: {}, tick: 0 } as any;
    const ms = new MovementSystem(bus, () => state, { smoothing: 1, extrapolationMs: 100 });
    bus.emit('playerMove', 'A');
    const t = performance.now();
    ms.interpolate(t + 1000); // capped at 100ms -> no velocity means no move
    expect(state.players.A.position).toEqual({ x: 0, y: 0 });
  });

  it('clamps velocity to maxSpeed', () => {
    const bus = new EventBus();
    const state = { players: { A: { id: 'A', position: { x: 0, y: 0 }, velocity: { x: 10000, y: 0 } } }, inventories: {}, objects: {}, tick: 0 } as any;
    const ms = new MovementSystem(bus, () => state, { smoothing: 1, extrapolationMs: 1000, worldBounds: { width: 10000, height: 10000 }, maxSpeed: 50 });
    bus.emit('playerMove', 'A');
    const t = performance.now();
    ms.interpolate(t + 1000); // 1s, clamped to 50
    // position increases by 50 * 1 * smoothing(1) = 50
    expect(state.players.A.position.x).toBe(50);
  });

  it('integrates Z and resolves simple 3D collisions', () => {
    const bus = new EventBus();
    const state = { players: { A: { id: 'A', position: { x: 0, y: 0, z: 0 }, velocity: { x: 10000, y: 0, z: 10000 } }, B: { id: 'B', position: { x: 1, y: 0, z: 0 } } }, inventories: {}, objects: {}, tick: 0 } as any;
    const ms = new MovementSystem(bus, () => state, { maxSpeed: 10, smoothing: 1, extrapolationMs: 1000, worldBounds: { width: 100, height: 100, depth: 100 }, playerRadius: 1 });
    bus.emit('playerMove', 'A');
    const t0 = performance.now();
    ms.interpolate(t0 + 100);
    expect(state.players.A.position.z!).toBeGreaterThan(0);
    expect(state.players.A.position.z!).toBeLessThanOrEqual(100);
    state.players.B.position = { x: state.players.A.position.x, y: state.players.A.position.y, z: state.players.A.position.z } as any;
    ms.resolveCollisions();
    const dx = state.players.B.position.x - state.players.A.position.x;
    const dy = state.players.B.position.y - state.players.A.position.y;
    const dz = (state.players.B.position.z ?? 0) - (state.players.A.position.z ?? 0);
    const distSq = dx*dx + dy*dy + dz*dz;
    expect(distSq).toBeGreaterThan(0);
  });
});


