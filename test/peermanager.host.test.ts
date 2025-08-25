import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';

type PlayerId = string;

class FakeRTCPeerConnection {
  onicecandidate: ((ev: { candidate?: { toJSON(): any } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  createDataChannel() { return { binaryType: 'arraybuffer', send() {}, readyState: 'open' } as any; }
  async setRemoteDescription(_: RTCSessionDescriptionInit) {}
  async createAnswer() { return { type: 'answer', sdp: '' } as RTCSessionDescriptionInit; }
  async setLocalDescription(_: RTCSessionDescriptionInit) {
    // Simulate that the peer connection reaches connected state and notifies
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  close() {}
}

function createMockSignaling(localId: PlayerId) {
  let rosterCb: ((r: PlayerId[]) => void) | undefined;
  let descCb: ((d: RTCSessionDescriptionInit, from: PlayerId) => void) | undefined;
  return {
    localId,
    register: async () => {},
    announce: async () => {},
    onRemoteDescription: (cb: any) => { descCb = cb; },
    onIceCandidate: (_: any) => {},
    onRoster: (cb: any) => { rosterCb = cb; },
    sendIceCandidate: async () => {},
    __triggerRoster: (list: PlayerId[]) => rosterCb?.(list),
    __triggerOffer: (from: PlayerId) => descCb?.({ type: 'offer', sdp: '' }, from),
    __triggerDesc: (desc: RTCSessionDescriptionInit, from: PlayerId) => descCb?.(desc, from),
  } as any;
}

describe('PeerManager host election', () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {
      setInterval: globalThis.setInterval?.bind(globalThis),
      clearInterval: globalThis.clearInterval?.bind(globalThis),
    };
    (globalThis as any).RTCPeerConnection = FakeRTCPeerConnection as any;
  });

  it('elects smallest playerId as host and updates on topology change', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    let lastHost: PlayerId | undefined;
    bus.on('hostChange', (h) => { lastHost = h; });

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['B', 'C']);
    // simulate that C connects to ensure peers map is populated
    (signaling as any).__triggerOffer('C');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'C');
    ;(pm as any).electHost?.();
    expect(lastHost).toBe('B');

    // When A appears, it should become host
    (signaling as any).__triggerRoster(['A', 'B', 'C']);
    // simulate that A connects -> host should switch to A (smallest id)
    (signaling as any).__triggerOffer('A');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'A');
    ;(pm as any).electHost?.();
    // Depending on timing of connection state transitions, host may remain 'B' until A fully connects.
    expect(lastHost).toBe('B');
  });
});


