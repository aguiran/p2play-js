import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { P2PGameLibrary } from '../src/game/GameLib';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling, FakeDataChannel } from './helpers/fakes';

const fakeCanvas = {
  width: 220,
  height: 120,
  style: {},
  parentNode: null,
  remove() {},
  getContext: () => ({
    clearRect: () => {}, fillStyle: '', fillText: () => {}, font: '',
    strokeStyle: '', strokeRect: () => {}, beginPath: () => {},
    moveTo: () => {}, lineTo: () => {}, stroke: () => {},
  }),
} as unknown as HTMLCanvasElement;

async function setupWithPeer(opts?: { cleanupOnPeerLeave?: boolean; conflictResolution?: string }) {
  const signaling = createMockSignaling('A');
  const game = new P2PGameLibrary({
    signaling: signaling as never,
    pingOverlay: { canvas: fakeCanvas },
    cleanupOnPeerLeave: opts?.cleanupOnPeerLeave,
    conflictResolution: opts?.conflictResolution as any,
  });
  await game.start();
  signaling.__triggerRoster(['A', 'B']);
  await new Promise(r => setImmediate(r));
  const pm = (game as any).peers as PeerManager;
  const peerB = pm.getPeer('B')!;
  return { game, signaling, pm, peerB };
}

function getSent(dc: RTCDataChannel | undefined): any[] {
  if (!dc) return [];
  return (dc as unknown as FakeDataChannel).sent.map(s =>
    typeof s === 'string' ? JSON.parse(s) : s
  );
}

describe('P2PGameLibrary API — sending methods', () => {
  beforeEach(() => { installFakeRTC(); });

  it('broadcastMove sends via unreliable channel', async () => {
    const { game, peerB } = await setupWithPeer();
    game.broadcastMove('A', { x: 10, y: 20 }, { x: 1, y: 0 });
    const msgs = getSent(peerB.dcUnreliable);
    expect(msgs.some(m => m.t === 'move' && m.position.x === 10)).toBe(true);
    game.stop();
  });

  it('updateInventory sends via reliable channel', async () => {
    const { game, peerB } = await setupWithPeer();
    game.updateInventory('A', [{ id: 'sword', type: 'weapon', quantity: 1 }]);
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'inventory')).toBe(true);
    game.stop();
  });

  it('transferItem sends via reliable channel', async () => {
    const { game, peerB } = await setupWithPeer();
    game.transferItem('A', 'B', { id: 'potion', type: 'heal', quantity: 1 });
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'transfer' && m.to === 'B')).toBe(true);
    game.stop();
  });

  it('broadcastPayload sends via reliable channel', async () => {
    const { game, peerB } = await setupWithPeer();
    game.broadcastPayload('A', { custom: true }, 'chat');
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'payload' && m.channel === 'chat')).toBe(true);
    game.stop();
  });

  it('sendPayload sends targeted to specific peer', async () => {
    const { game, peerB } = await setupWithPeer();
    game.sendPayload('A', 'B', { secret: 42 }, 'dm');
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'payload' && m.payload.secret === 42)).toBe(true);
    game.stop();
  });

  it('broadcastFullState sends via reliable channel', async () => {
    const { game, peerB } = await setupWithPeer();
    const before = getSent(peerB.dcReliable).length;
    game.broadcastFullState('A');
    const msgs = getSent(peerB.dcReliable).slice(before);
    expect(msgs.some(m => m.t === 'state_full')).toBe(true);
    game.stop();
  });
});

describe('P2PGameLibrary API — state & delta', () => {
  beforeEach(() => { installFakeRTC(); });

  it('broadcastDelta sends state_delta with correct paths', async () => {
    const { game, peerB } = await setupWithPeer();
    game.broadcastDelta('A', ['objects.foo']);
    const msgs = getSent(peerB.dcReliable);
    const delta = msgs.find(m => m.t === 'state_delta');
    expect(delta).toBeDefined();
    expect(delta.delta.changes[0].path).toBe('objects.foo');
    game.stop();
  });

  it('setStateAndBroadcast mutates state and sends delta', async () => {
    const { game, peerB } = await setupWithPeer();
    const paths = game.setStateAndBroadcast('A', [{ path: 'objects.score', value: 100 }]);
    expect(paths).toEqual(['objects.score']);
    expect((game.getState().objects as any).score).toBe(100);
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'state_delta')).toBe(true);
    game.stop();
  });

  it('getState returns deep clone', async () => {
    const { game } = await setupWithPeer();
    game.announcePresence('A', { x: 1, y: 2 });
    const a = game.getState();
    const b = game.getState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    game.stop();
  });
});

describe('P2PGameLibrary API — event handlers', () => {
  beforeEach(() => { installFakeRTC(); });

  it('hostChange broadcasts full state when becoming host', async () => {
    const { game, peerB } = await setupWithPeer();
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'state_full')).toBe(true);
    game.stop();
  });

  it('peerJoin hydrates new peer with state_full when host', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(10);
    const pm = (game as any).peers as PeerManager;
    const peerB = pm.getPeer('B');
    const msgs = getSent(peerB?.dcReliable);
    const fullMsgs = msgs.filter(m => m.t === 'state_full');
    expect(fullMsgs.length).toBeGreaterThanOrEqual(2);
    game.stop();
    vi.useRealTimers();
  });

  it('peerLeave cleans up peer data when host and cleanupOnPeerLeave', async () => {
    const { game, peerB } = await setupWithPeer({ cleanupOnPeerLeave: true });
    const smState = (game as any).state.getState();
    smState.players['B'] = { id: 'B', position: { x: 5, y: 5 } };
    smState.inventories['B'] = [{ id: 'item', type: 't', quantity: 1 }];

    (peerB.rtc as any).connectionState = 'disconnected';
    (peerB.rtc as any).onconnectionstatechange?.();

    const state = game.getState();
    expect(state.players['B']).toBeUndefined();
    expect(state.inventories['B']).toBeUndefined();
    game.stop();
  });

  it('hostChange in authoritative mode binds authoritativeClientId to host', async () => {
    const { game } = await setupWithPeer({ conflictResolution: 'authoritative' });
    expect((game as any).options.authoritativeClientId).toBe('A');
    game.stop();
  });
});

describe('P2PGameLibrary API — utilities', () => {
  beforeEach(() => { installFakeRTC(); });

  it('tick() executes without error', async () => {
    const { game } = await setupWithPeer();
    expect(() => game.tick()).not.toThrow();
    game.stop();
  });

  it('getHostId returns elected host', async () => {
    const { game } = await setupWithPeer();
    expect(game.getHostId()).toBe('A');
    game.stop();
  });

  it('setPingOverlayEnabled toggles without error', async () => {
    const { game } = await setupWithPeer();
    expect(() => game.setPingOverlayEnabled(true)).not.toThrow();
    expect(() => game.setPingOverlayEnabled(false)).not.toThrow();
    game.stop();
  });

  it('announcePresence adds player to state if absent', async () => {
    const { game } = await setupWithPeer();
    game.announcePresence('A', { x: 42, y: 7 });
    expect(game.getState().players['A']?.position).toEqual({ x: 42, y: 7 });
    game.stop();
  });

  it('nextSeq increments for successive messages', async () => {
    const { game, peerB } = await setupWithPeer();
    game.updateInventory('A', []);
    game.updateInventory('A', []);
    const msgs = getSent(peerB.dcReliable).filter(m => m.t === 'inventory');
    expect(msgs.length).toBe(2);
    expect(msgs[1].seq).toBe(msgs[0].seq + 1);
    game.stop();
  });
});

describe('P2PGameLibrary API — disposed guards', () => {
  beforeEach(() => { installFakeRTC(); });

  it('all remaining public methods throw after stop()', async () => {
    const { game } = await setupWithPeer();
    game.stop();
    expect(() => game.setStateAndBroadcast('A', [])).toThrow('disposed');
    expect(() => game.announcePresence('A')).toThrow('disposed');
    expect(() => game.updateInventory('A', [])).toThrow('disposed');
    expect(() => game.transferItem('A', 'B', { id: 'x', type: 't', quantity: 1 })).toThrow('disposed');
    expect(() => game.broadcastPayload('A', {})).toThrow('disposed');
    expect(() => game.sendPayload('A', 'B', {})).toThrow('disposed');
    expect(() => game.broadcastFullState('A')).toThrow('disposed');
  });
});
