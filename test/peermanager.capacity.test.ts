import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import type { PlayerId } from '../src/types';

class FakeDataChannel {
  readyState: 'open' | 'closed' = 'open';
  bufferedAmount = 0;
  binaryType: 'arraybuffer' = 'arraybuffer';
  onmessage: ((ev: any) => void) | null = null;
  onopen: (() => void) | null = null;
  send(_: any) {}
}

class FakeRTCPeerConnection {
  onicecandidate: ((ev: { candidate?: { toJSON(): any } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  private _dc?: FakeDataChannel;
  createDataChannel(): FakeDataChannel {
    this._dc = new FakeDataChannel();
    return this._dc;
  }
  get dc(): FakeDataChannel | undefined { return this._dc; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: '' }; }
  async setLocalDescription(_: RTCSessionDescriptionInit): Promise<void> {}
  async setRemoteDescription(_: RTCSessionDescriptionInit): Promise<void> {}
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: '' }; }
  async addIceCandidate(_: RTCIceCandidateInit): Promise<void> {}
  close() {}
}

type RosterCb = (roster: PlayerId[]) => void;
type DescCb = (desc: RTCSessionDescriptionInit, from: PlayerId) => void;
type IceCb = (candidate: RTCIceCandidateInit, from: PlayerId) => void;

function createMockSignaling(localId: PlayerId) {
  let rosterCb: RosterCb | undefined;
  let descCb: DescCb | undefined;
  let iceCb: IceCb | undefined;
  return {
    localId,
    register: async () => {},
    announce: async (_: RTCSessionDescriptionInit, __?: PlayerId) => {},
    onRemoteDescription: (cb: DescCb) => { descCb = cb; },
    onIceCandidate: (cb: IceCb) => { iceCb = cb; },
    onRoster: (cb: RosterCb) => { rosterCb = cb; },
    sendIceCandidate: async (_: RTCIceCandidateInit, __?: PlayerId) => {},
    __triggerRoster: (list: PlayerId[]) => rosterCb?.(list),
    __triggerDesc: (desc: RTCSessionDescriptionInit, from: PlayerId) => descCb?.(desc, from),
    __triggerIce: (cand: RTCIceCandidateInit, from: PlayerId) => iceCb?.(cand, from),
  } as any;
}

describe('PeerManager capacity', () => {
  beforeEach(() => {
    // Provide minimal window timers for startPingLoop
    (globalThis as any).window = (globalThis as any).window ?? {
      setInterval: globalThis.setInterval?.bind(globalThis),
      clearInterval: globalThis.clearInterval?.bind(globalThis),
    };
    // Stub RTCPeerConnection
    (globalThis as any).RTCPeerConnection = FakeRTCPeerConnection as any;
  });

  it('emits maxCapacityReached when initiating beyond capacity', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'coalesce-moves', thresholdBytes: 262144 }, 2);

    let emittedMax: number | undefined;
    bus.on('maxCapacityReached', (max) => { emittedMax = max; });

    await pm.createOrJoin();
    // Roster includes two other peers; capacity allows only 1 remote
    (signaling as any).__triggerRoster(['A', 'B', 'C']);

    expect(emittedMax).toBe(2);
  });

  it('emits maxCapacityReached when receiving offer beyond capacity', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'coalesce-moves', thresholdBytes: 262144 }, 2);

    let count = 0;
    bus.on('maxCapacityReached', () => { count++; });

    await pm.createOrJoin();
    // First, consume capacity with one pending initiator
    (signaling as any).__triggerRoster(['A', 'B']);
    // Now, simulate an incoming offer from C -> should be refused due to capacity
    (signaling as any).__triggerDesc({ type: 'offer', sdp: '' }, 'C');

    expect(count).toBeGreaterThan(0);
  });
});


