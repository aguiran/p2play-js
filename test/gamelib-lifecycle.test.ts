import { describe, it, expect, beforeEach, vi } from 'vitest';
import { P2PGameLibrary } from '../src/game/GameLib';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

type PlayerId = string;

const fakeCanvas = {
  width: 220,
  height: 120,
  style: {},
  parentNode: null,
  remove() {},
  getContext: () => ({ clearRect: () => {}, fillStyle: '', fillText: () => {}, font: '', strokeStyle: '', strokeRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {} }),
} as unknown as HTMLCanvasElement;

describe('P2PGameLibrary lifecycle (Lot 4)', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('stop() is idempotent (second call does not throw)', async () => {
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    (signaling as ReturnType<typeof createMockSignaling>).__triggerRoster(['A']);
    game.stop();
    expect(() => game.stop()).not.toThrow();
  });

  it('public methods throw after stop()', async () => {
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    game.stop();
    await expect(game.start()).rejects.toThrow('disposed');
    expect(() => game.broadcastMove('A', { x: 0, y: 0 })).toThrow('disposed');
    expect(() => game.getState()).toThrow('disposed');
    expect(() => game.getHostId()).toThrow('disposed');
    expect(() => game.on('peerJoin', () => {})).toThrow('disposed');
    expect(() => game.tick()).toThrow('disposed');
    expect(() => game.broadcastDelta('A', [])).toThrow('disposed');
    expect(() => game.setPingOverlayEnabled(true)).toThrow('disposed');
  });

  it('clearInterval called on stop (ping loop cleared)', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    (signaling as ReturnType<typeof createMockSignaling>).__triggerRoster(['A']);
    const before = clearIntervalSpy.mock.calls.length;
    game.stop();
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(before);
    clearIntervalSpy.mockRestore();
  });

  it('getState() returns a copy: mutating it does not affect internal state', async () => {
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    game.announcePresence('A', { x: 10, y: 20 });
    const first = game.getState();
    expect(first.players['A']?.position).toEqual({ x: 10, y: 20 });
    (first.players as Record<string, unknown>)['A'] = { id: 'A', position: { x: 999, y: 999 } };
    const second = game.getState();
    expect(second.players['A']?.position).toEqual({ x: 10, y: 20 });
    expect(first).not.toBe(second);
  });
});

describe('PeerManager dispose clears pendingInitiators', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('dispose() clears peers and pendingInitiators', async () => {
    const { EventBus } = await import('../src/events/EventBus');
    const bus = new EventBus();
    const signaling = createMockSignaling('2');
    const pm = new PeerManager(bus, signaling as never);
    await pm.createOrJoin();
    (signaling as ReturnType<typeof createMockSignaling>).__triggerRoster(['2', '10']);
    await new Promise((r) => setImmediate(r));
    pm.dispose();
    const pendingAfter = (pm as unknown as { pendingInitiators: Map<string, unknown> }).pendingInitiators?.size ?? 0;
    expect(pm.getPeerIds().length).toBe(0);
    expect(pendingAfter).toBe(0);
  });
});
