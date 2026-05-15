import { describe, it, expect, beforeEach, vi } from 'vitest';
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

async function setupWithPeer() {
  const signaling = createMockSignaling('A');
  const game = new P2PGameLibrary({
    signaling: signaling as never,
    pingOverlay: { canvas: fakeCanvas },
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

describe('Sender state_delta / state_full local emission', () => {
  beforeEach(() => { installFakeRTC(); });

  it('setStateAndBroadcast emits stateDelta locally for the sender', async () => {
    const { game } = await setupWithPeer();
    const deltas: any[] = [];
    game.on('stateDelta', (d) => deltas.push(d));
    game.setStateAndBroadcast('A', [{ path: 'objects.score', value: 42 }]);
    expect(deltas.length).toBe(1);
    expect(deltas[0].changes).toEqual([{ path: 'objects.score', value: 42 }]);
    game.stop();
  });

  it('broadcastDelta emits stateDelta locally for the sender', async () => {
    const { game } = await setupWithPeer();
    // pre-populate state without going through setStateAndBroadcast
    const sm = (game as any).state;
    sm.setPathsValues([{ path: 'objects.greeting', value: 'hi' }]);
    const deltas: any[] = [];
    game.on('stateDelta', (d) => deltas.push(d));
    game.broadcastDelta('A', ['objects.greeting']);
    expect(deltas.length).toBe(1);
    expect(deltas[0].changes[0]).toEqual({ path: 'objects.greeting', value: 'hi' });
    game.stop();
  });

  it('broadcastFullState emits stateSync locally for the sender', async () => {
    const { game } = await setupWithPeer();
    const syncs: any[] = [];
    game.on('stateSync', (st) => syncs.push(st));
    game.broadcastFullState('A');
    expect(syncs.length).toBe(1);
    expect(syncs[0]).toBeDefined();
    expect(syncs[0].players).toBeDefined();
    game.stop();
  });

  it('setStateAndBroadcast: tick is incremented exactly once', async () => {
    const { game } = await setupWithPeer();
    const sm = (game as any).state;
    const tickBefore = sm.getState().tick;
    game.setStateAndBroadcast('A', [{ path: 'objects.score', value: 1 }]);
    expect(sm.getState().tick).toBe(tickBefore + 1);
    game.stop();
  });

  it('setStateAndBroadcast: delta sent to peers matches the locally emitted delta', async () => {
    const { game, peerB } = await setupWithPeer();
    let localDelta: any = null;
    game.on('stateDelta', (d) => { localDelta = d; });
    game.setStateAndBroadcast('A', [{ path: 'objects.score', value: 7 }]);
    const remoteMsg = getSent(peerB.dcReliable).find(m => m.t === 'state_delta' && m.delta?.changes?.[0]?.path === 'objects.score');
    expect(remoteMsg).toBeDefined();
    expect(remoteMsg.delta).toEqual(localDelta);
    game.stop();
  });
});

describe('Sender inventory / transfer / move local emission', () => {
  beforeEach(() => { installFakeRTC(); });

  it('updateInventory mutates the sender local state', async () => {
    const { game } = await setupWithPeer();
    const items = [{ id: 'sword', type: 'weapon', quantity: 1 }];
    game.updateInventory('A', items);
    expect(game.getState().inventories['A']).toEqual(items);
    game.stop();
  });

  it('updateInventory emits inventoryUpdate locally for the sender', async () => {
    const { game } = await setupWithPeer();
    const updates: any[] = [];
    game.on('inventoryUpdate', (pid, inv) => updates.push({ pid, inv }));
    const items = [{ id: 'potion', type: 'heal', quantity: 3 }];
    game.updateInventory('A', items);
    expect(updates.length).toBe(1);
    expect(updates[0].pid).toBe('A');
    expect(updates[0].inv).toEqual(items);
    game.stop();
  });

  it('transferItem mutates the sender local state and emits objectTransfer locally', async () => {
    const { game } = await setupWithPeer();
    // seed inventory for A
    game.updateInventory('A', [{ id: 'potion', type: 'heal', quantity: 2 }]);
    const events: any[] = [];
    game.on('objectTransfer', (from, to, item) => events.push({ from, to, item }));
    game.transferItem('A', 'B', { id: 'potion', type: 'heal', quantity: 1 });
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'A', to: 'B', item: { id: 'potion', type: 'heal', quantity: 1 } });
    const state = game.getState();
    expect(state.inventories['A']).toEqual([{ id: 'potion', type: 'heal', quantity: 1 }]);
    expect(state.inventories['B']).toEqual([{ id: 'potion', type: 'heal', quantity: 1 }]);
    game.stop();
  });

  it('broadcastMove emits playerMove locally for the sender and mutates state', async () => {
    const { game } = await setupWithPeer();
    const moves: any[] = [];
    game.on('playerMove', (pid, pos) => moves.push({ pid, pos }));
    game.broadcastMove('A', { x: 10, y: 20 });
    expect(moves.length).toBe(1);
    expect(moves[0]).toEqual({ pid: 'A', pos: { x: 10, y: 20 } });
    expect(game.getState().players['A']?.position).toEqual({ x: 10, y: 20 });
    game.stop();
  });

  it('announcePresence emits playerMove locally for the sender', async () => {
    const { game } = await setupWithPeer();
    const moves: any[] = [];
    game.on('playerMove', (pid, pos) => moves.push({ pid, pos }));
    game.announcePresence('A', { x: 5, y: 6 });
    expect(moves.length).toBe(1);
    expect(moves[0]).toEqual({ pid: 'A', pos: { x: 5, y: 6 } });
    game.stop();
  });

  it('broadcastPayload emits sharedPayload locally for the sender', async () => {
    const { game } = await setupWithPeer();
    const events: any[] = [];
    game.on('sharedPayload', (from, payload, channel) => events.push({ from, payload, channel }));
    game.broadcastPayload('A', { msg: 'hello' }, 'chat');
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'A', payload: { msg: 'hello' }, channel: 'chat' });
    game.stop();
  });
});

describe('Host registers joining peer in state.players', () => {
  beforeEach(() => { installFakeRTC(); });

  it('host inserts the joining peer into state.players', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(10);

    const state = game.getState();
    expect(state.players['B']).toBeDefined();
    expect(state.players['B'].position).toEqual({ x: 0, y: 0 });
    game.stop();
    vi.useRealTimers();
  });

  it('host emits a stateDelta locally for the new player insertion', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    const deltas: any[] = [];
    game.on('stateDelta', (d) => deltas.push(d));
    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(10);

    const playerDelta = deltas.find(d => d.changes.some((c: any) => c.path === 'players.B'));
    expect(playerDelta).toBeDefined();
    const change = playerDelta.changes.find((c: any) => c.path === 'players.B');
    expect(change.value).toEqual({ id: 'B', position: { x: 0, y: 0 } });
    game.stop();
    vi.useRealTimers();
  });

  it('host does NOT broadcast a players.<peerId> delta on peerJoin (avoids race with the joiner\'s announcePresence)', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(10);

    const pm = (game as any).peers as PeerManager;
    const peerB = pm.getPeer('B')!;
    const msgs = getSent(peerB.dcReliable);
    // The joiner is sender-owned for its players.<id> path; a host-broadcast
    // snapshot here would race with announcePresence on the unreliable channel.
    const playerDelta = msgs.find(m => m.t === 'state_delta' && m.delta?.changes?.some((c: any) => c.path === 'players.B'));
    expect(playerDelta).toBeUndefined();
    // But the joiner still receives a state_full (which is reliable + ordered
    // with prior host messages) so it can see its own entry.
    const stateFull = msgs.find(m => m.t === 'state_full');
    expect(stateFull).toBeDefined();
    game.stop();
    vi.useRealTimers();
  });

  it('does not throw or mutate state after stop() between peerJoin and deferred handler', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    signaling.__triggerRoster(['A', 'B']);
    // peerJoin has fired synchronously and scheduled the setTimeout(0).
    game.stop();
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    vi.useRealTimers();
  });

  it('host does not re-insert an already-known player on peerJoin', async () => {
    vi.useFakeTimers();
    installFakeRTC();
    const signaling = createMockSignaling('A');
    const game = new P2PGameLibrary({ signaling: signaling as never, pingOverlay: { canvas: fakeCanvas } });
    await game.start();
    // Pre-register B with a non-default position to detect overwrite
    const sm = (game as any).state;
    sm.getState().players['B'] = { id: 'B', position: { x: 99, y: 99 } };
    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(10);

    expect(game.getState().players['B'].position).toEqual({ x: 99, y: 99 });
    game.stop();
    vi.useRealTimers();
  });
});

describe('sendPayload self-target short-circuit', () => {
  beforeEach(() => { installFakeRTC(); });

  it('sendPayload(self, self, payload) emits sharedPayload locally', async () => {
    const { game } = await setupWithPeer();
    const events: any[] = [];
    game.on('sharedPayload', (from, payload, channel) => events.push({ from, payload, channel }));
    game.sendPayload('A', 'A', { secret: 42 }, 'role');
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'A', payload: { secret: 42 }, channel: 'role' });
    game.stop();
  });

  it('sendPayload(self, other, payload) still goes through DataChannel (no local emit)', async () => {
    const { game, peerB } = await setupWithPeer();
    const events: any[] = [];
    game.on('sharedPayload', (from, payload, channel) => events.push({ from, payload, channel }));
    game.sendPayload('A', 'B', { hi: 1 }, 'dm');
    expect(events.length).toBe(0);
    const msgs = getSent(peerB.dcReliable);
    expect(msgs.some(m => m.t === 'payload' && m.payload?.hi === 1)).toBe(true);
    game.stop();
  });
});
