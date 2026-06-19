import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling, linkMockSignalings, FakeRTCPeerConnection, FakeDataChannel } from './helpers/fakes';

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function setupLinkedPair() {
  const sigA = createMockSignaling('A');
  const sigB = createMockSignaling('B');
  linkMockSignalings([sigA, sigB]);
  const busA = new EventBus();
  const busB = new EventBus();
  const pmA = new PeerManager(busA, sigA as any);
  const pmB = new PeerManager(busB, sigB as any);
  await pmA.createOrJoin();
  await pmB.createOrJoin();
  sigA.__triggerRoster(['A', 'B']);
  sigB.__triggerRoster(['A', 'B']);
  await flush();
  return { sigA, sigB, busA, busB, pmA, pmB };
}

describe('PeerManager renegotiation', () => {
  beforeEach(() => { installFakeRTC(); });

  it('renegotiate() sends an offer and settles when the answer arrives', async () => {
    const { pmA, pmB } = await setupLinkedPair();
    const settledA: string[] = [];
    pmA.setMediaNegotiationHooks({ onNegotiationSettled: (id) => settledA.push(id) });

    await pmA.renegotiate('B');
    await flush();

    const rtcA = pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection;
    const rtcB = pmB.getPeer('A')!.rtc as unknown as FakeRTCPeerConnection;
    expect(rtcA.signalingState).toBe('stable');
    expect(rtcB.signalingState).toBe('stable');
    expect(settledA).toEqual(['B']);
    expect(pmA.getPeer('B')!.negotiating).toBe(false);
  });

  it('answerer side fires onRemoteOfferApplied before answering and onNegotiationSettled after', async () => {
    const { pmA, pmB } = await setupLinkedPair();
    const order: string[] = [];
    pmB.setMediaNegotiationHooks({
      onRemoteOfferApplied: () => { order.push('offerApplied'); },
      onNegotiationSettled: () => { order.push('settled'); },
    });

    await pmA.renegotiate('B');
    await flush();

    expect(order).toEqual(['offerApplied', 'settled']);
  });

  it('keeps DataChannels open and routable through renegotiation (SA1/SA6)', async () => {
    const { pmA, pmB } = await setupLinkedPair();
    const peerB = pmA.getPeer('B')!;
    const dcReliableBefore = peerB.dcReliable;
    const dcUnreliableBefore = peerB.dcUnreliable;
    expect(dcReliableBefore?.readyState).toBe('open');

    await pmA.renegotiate('B');
    await flush();

    // Same channel instances, never recreated nor closed
    expect(pmA.getPeer('B')!.dcReliable).toBe(dcReliableBefore);
    expect(pmA.getPeer('B')!.dcUnreliable).toBe(dcUnreliableBefore);
    expect(dcReliableBefore?.readyState).toBe('open');

    pmA.send('B', { t: 'payload', from: 'A', ts: 1, payload: { ok: true } } as any);
    const sent = (dcReliableBefore as unknown as FakeDataChannel).sent;
    expect(sent.some((s) => typeof s === 'string' && (JSON.parse(s) as any).t === 'payload')).toBe(true);
    // Peer was not torn down / re-joined
    expect(pmA.getPeerIds()).toEqual(['B']);
    expect(pmB.getPeerIds()).toEqual(['A']);
  });

  it('queues a renegotiation requested while another is in flight', async () => {
    const { pmA, sigA } = await setupLinkedPair();
    const announced: string[] = [];
    const originalAnnounce = sigA.announce;
    sigA.announce = async (desc: RTCSessionDescriptionInit, to?: string) => {
      announced.push(desc.type!);
      return originalAnnounce(desc, to);
    };

    await pmA.renegotiate('B');
    // First negotiation still in flight (answer not yet delivered)
    await pmA.renegotiate('B');
    expect(pmA.getPeer('B')!.needsRenegotiation).toBe(true);
    await flush(6);

    // Two offers announced in total: the in-flight one, then the queued replay
    expect(announced.filter((t) => t === 'offer').length).toBe(2);
    expect(pmA.getPeer('B')!.needsRenegotiation).toBe(false);
    expect((pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection).signalingState).toBe('stable');
  });

  it('glare: impolite peer ignores the colliding offer', async () => {
    // A is impolite towards B (comparePlayerIds('A','B') < 0, same as mesh initiator)
    const sigA = createMockSignaling('A');
    const announced: string[] = [];
    sigA.announce = async (desc: RTCSessionDescriptionInit) => { announced.push(desc.type!); };
    const pmA = new PeerManager(new EventBus(), sigA as any);
    await pmA.createOrJoin();
    sigA.__triggerRoster(['A', 'B']);
    await flush();
    sigA.__triggerDesc({ type: 'answer', sdp: '' }, 'B'); // complete initial mesh
    await flush();

    await pmA.renegotiate('B'); // our offer is in flight
    const rtcA = pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection;
    expect(rtcA.signalingState).toBe('have-local-offer');
    const before = announced.length;

    sigA.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }, 'B');
    await flush();

    // Ignored: no answer announced, our offer still pending
    expect(announced.length).toBe(before);
    expect(rtcA.signalingState).toBe('have-local-offer');
  });

  it('glare: polite peer rolls back, answers, then replays its own offer', async () => {
    // B is polite towards A (comparePlayerIds('B','A') > 0)
    const sigB = createMockSignaling('B');
    const announced: string[] = [];
    sigB.announce = async (desc: RTCSessionDescriptionInit) => { announced.push(desc.type!); };
    const pmB = new PeerManager(new EventBus(), sigB as any);
    await pmB.createOrJoin();
    sigB.__triggerRoster(['A', 'B']);
    await flush();
    // B is the mesh answerer: receive initial offer from A
    sigB.__triggerOffer('A');
    await flush();
    announced.length = 0;

    await pmB.renegotiate('A'); // B's renegotiation offer in flight
    const rtcB = pmB.getPeer('A')!.rtc as unknown as FakeRTCPeerConnection;
    expect(rtcB.signalingState).toBe('have-local-offer');

    // Colliding offer from A arrives
    sigB.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }, 'A');
    await flush(6);

    // offer (ours) -> answer (rollback + respond) -> offer (replayed intent)
    expect(announced).toEqual(['offer', 'answer', 'offer']);
    expect(rtcB.signalingState).toBe('have-local-offer');
  });

  it('accepts a renegotiation offer from a connected peer even when the room is full', async () => {
    const sigA = createMockSignaling('A');
    const announced: Array<{ type: string; to?: string }> = [];
    sigA.announce = async (desc: RTCSessionDescriptionInit, to?: string) => { announced.push({ type: desc.type!, to }); };
    const bus = new EventBus();
    const maxCapacity = vi.fn();
    bus.on('maxCapacityReached', maxCapacity);
    const pmA = new PeerManager(bus, sigA as any, 'json', undefined, undefined, undefined, 2 /* maxPlayers: room is full with B */);
    await pmA.createOrJoin();
    sigA.__triggerRoster(['A', 'B']);
    await flush();
    sigA.__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await flush();
    expect(pmA.getPeerIds()).toEqual(['B']);
    announced.length = 0;

    sigA.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly' }, 'B');
    await flush();

    expect(announced.some((a) => a.type === 'answer' && a.to === 'B')).toBe(true);
    expect(maxCapacity).not.toHaveBeenCalled();
  });

  it('renegotiate() rejects for an unknown peer', async () => {
    const { pmA } = await setupLinkedPair();
    await expect(pmA.renegotiate('Z')).rejects.toThrow(/unknown peer/);
  });

  it('ignores an offer while the peer connection is still connecting', async () => {
    const { pmA, sigA } = await setupLinkedPair();
    const rtcA = pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection;
    rtcA.connectionState = 'connecting';
    const announced: string[] = [];
    sigA.announce = async (desc: RTCSessionDescriptionInit) => { announced.push(desc.type!); };

    sigA.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }, 'B');
    await flush();

    expect(announced).toEqual([]);
  });

  it('ignores a renegotiation offer while already processing one (have-remote-offer)', async () => {
    const { pmA, sigA } = await setupLinkedPair();
    const rtcA = pmA.getPeer('B')!.rtc as unknown as FakeRTCPeerConnection;
    rtcA.signalingState = 'have-remote-offer';
    const announced: string[] = [];
    sigA.announce = async (desc: RTCSessionDescriptionInit) => { announced.push(desc.type!); };

    sigA.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }, 'B');
    await flush();

    expect(announced).toEqual([]);
  });
});
