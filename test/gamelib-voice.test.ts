import { describe, it, expect, beforeEach } from 'vitest';
import { P2PGameLibrary } from '../src/game/GameLib';
import { PeerManager } from '../src/net/PeerManager';
import {
  installFakeRTC,
  installFakeGetUserMedia,
  createMockSignaling,
  linkMockSignalings,
  FakeRTCPeerConnection,
} from './helpers/fakes';

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

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

async function setupGames(ids: string[]) {
  const sigs = ids.map((id) => createMockSignaling(id));
  linkMockSignalings(sigs);
  const games = sigs.map((sig) => new P2PGameLibrary({
    signaling: sig as never,
    pingOverlay: { canvas: fakeCanvas },
  }));
  for (const g of games) await g.start();
  for (const sig of sigs) sig.__triggerRoster(ids);
  await flush();
  return { games, sigs };
}

describe('P2PGameLibrary voice integration', () => {
  beforeEach(() => { installFakeRTC(); });

  it('exposes a voice API and completes a talk handshake between two libraries', async () => {
    installFakeGetUserMedia();
    const { games } = await setupGames(['A', 'B']);
    const [gameA, gameB] = games;

    await gameA.voice.start('B', { mode: 'talk' });

    expect(gameA.voice.getActiveLinks()).toEqual([{ peerId: 'B', mode: 'talk', state: 'connected' }]);
    // Remote side auto-handled the renegotiation, no app call needed
    expect(gameB.voice.getActiveLinks()).toEqual([{ peerId: 'A', mode: 'talk', state: 'connected' }]);

    // Game traffic still works after the voice renegotiation
    const pmA = (gameA as any).peers as PeerManager;
    expect(pmA.getPeer('B')!.dcReliable?.readyState).toBe('open');
    gameA.broadcastMove('A', { x: 5, y: 6 });

    games.forEach((g) => g.stop());
  });

  it('cleans up voice links when a peer leaves the room', async () => {
    installFakeGetUserMedia();
    const { games, sigs } = await setupGames(['A', 'B']);
    const [gameA] = games;
    await gameA.voice.start('B', { mode: 'talk' });

    const states: string[] = [];
    gameA.voice.on('state', (_pid, s) => states.push(s));
    sigs[0].__triggerRoster(['A']); // B leaves
    await flush();

    expect(states).toContain('disconnected');
    expect(gameA.voice.getActiveLinks()).toEqual([]);
    games.forEach((g) => g.stop());
  });

  it('stop() disposes the voice manager', async () => {
    installFakeGetUserMedia();
    const { games } = await setupGames(['A', 'B']);
    const [gameA] = games;
    await gameA.voice.start('B', { mode: 'talk' });

    gameA.stop();
    expect(gameA.voice.getActiveLinks()).toEqual([]);
    await expect(gameA.voice.start('B', { mode: 'talk' })).rejects.toThrow(/disposed/);
    games[1].stop();
  });

  it('voice renegotiation does not disturb host election or peer roster', async () => {
    installFakeGetUserMedia();
    const { games } = await setupGames(['A', 'B']);
    const [gameA, gameB] = games;
    expect(gameA.getHostId()).toBe('A');

    await gameA.voice.start('B', { mode: 'listen' });

    expect(gameA.getHostId()).toBe('A');
    expect(gameB.getHostId()).toBe('A');
    const pmA = (gameA as any).peers as PeerManager;
    expect(pmA.getPeerIds()).toEqual(['B']);
    expect((pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection).connectionState).toBe('connected');
    games.forEach((g) => g.stop());
  });
});
