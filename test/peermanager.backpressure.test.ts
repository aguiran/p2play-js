import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import type { NetMessage } from '../src/types';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager backpressure', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  it('drop-moves: drops moves when bufferedAmount over threshold (no enqueue)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'drop-moves', thresholdBytes: 1 });
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    peer.dcUnreliable.bufferedAmount = 10;
    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 }, seq: 1 } as any;
    ;(pm as any).send('B', msg);
    expect(peer.outboxUnreliable?.length ?? 0).toBe(0);
  });

  it('coalesce-moves: replaces last queued move with latest', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'coalesce-moves', thresholdBytes: 262144 });
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    peer.dcUnreliable.readyState = 'closed';
    const move1: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 1, y: 1 }, seq: 1 } as any;
    const move2: NetMessage = { t: 'move', from: 'A', ts: 2, position: { x: 2, y: 2 }, seq: 2 } as any;
    ;(pm as any).send('B', move1);
    ;(pm as any).send('B', move2);
    const texts = (peer.outboxUnreliable as (string|ArrayBuffer)[]).map((p: string | ArrayBuffer) => typeof p === 'string' ? p : new TextDecoder().decode(p as ArrayBuffer));
    const parsed = texts.map((t: string) => JSON.parse(t));
    expect(parsed.length).toBe(1);
    expect(parsed[0].position).toEqual({ x: 2, y: 2 });
  });
});
