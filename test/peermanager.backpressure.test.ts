import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import type { NetMessage } from '../src/types';

class FakeDataChannel {
  readyState: 'open' | 'closed' = 'open';
  bufferedAmount = 0;
  binaryType: 'arraybuffer' = 'arraybuffer';
  sent: any[] = [];
  send(p: any) { this.sent.push(p); }
}

class FakeRTCPeerConnection {
  onicecandidate: ((ev: { candidate?: { toJSON(): any } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  dc?: FakeDataChannel;
  createDataChannel() { this.dc = new FakeDataChannel(); return this.dc; }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    if (desc.type === 'answer') this.signalingState = 'stable';
  }
  async createAnswer() { return { type: 'answer', sdp: '' } as RTCSessionDescriptionInit; }
  async setLocalDescription(_: RTCSessionDescriptionInit) { this.signalingState = 'have-local-offer'; }
  close() {}
}

function createMockSignaling(localId: string) {
  let rosterCb: ((r: string[]) => void) | undefined;
  let descCb: ((d: RTCSessionDescriptionInit, from: string) => void) | undefined;
  return {
    localId,
    register: async () => {},
    announce: async () => {},
    onRemoteDescription: (cb: any) => { descCb = cb; },
    onIceCandidate: (_: any) => {},
    onRoster: (cb: any) => { rosterCb = cb; },
    sendIceCandidate: async () => {},
    __triggerRoster: (list: string[]) => rosterCb?.(list),
    __triggerOffer: (from: string) => descCb?.({ type: 'offer', sdp: '' }, from),
    __triggerDesc: (desc: RTCSessionDescriptionInit, from: string) => descCb?.(desc, from),
  } as any;
}

describe('PeerManager backpressure', () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {
      setInterval: globalThis.setInterval?.bind(globalThis),
      clearInterval: globalThis.clearInterval?.bind(globalThis),
    };
    (globalThis as any).RTCPeerConnection = FakeRTCPeerConnection as any;
  });

  it('drop-moves: drops moves when bufferedAmount over threshold (no enqueue)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'drop-moves', thresholdBytes: 1 });
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    // finalize connection by simulating remote answer
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    peer.dc.bufferedAmount = 10; // exceed threshold
    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 0, y: 0 }, seq: 1 } as any;
    // drop-moves: nothing should be queued when saturated
    ;(pm as any).send('B', msg);
    expect(peer.outbox?.length ?? 0).toBe(0);
  });

  it('coalesce-moves: replaces last queued move with latest', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'coalesce-moves', thresholdBytes: 262144 });
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    // force queueing by closing DC so trySend returns false
    peer.dc.readyState = 'closed';
    // simulate two queued moves; second should replace the first
    const move1: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 1, y: 1 }, seq: 1 } as any;
    const move2: NetMessage = { t: 'move', from: 'A', ts: 2, position: { x: 2, y: 2 }, seq: 2 } as any;
    ;(pm as any).send('B', move1);
    ;(pm as any).send('B', move2);
    // coalescing happens by replacing last move in outbox
    const texts = (peer.outbox as (string|ArrayBuffer)[]).map((p) => typeof p === 'string' ? p : new TextDecoder().decode(p as ArrayBuffer));
    const parsed = texts.map((t) => JSON.parse(t));
    expect(parsed.length).toBe(1);
    expect(parsed[0].position).toEqual({ x: 2, y: 2 });
  });
});


