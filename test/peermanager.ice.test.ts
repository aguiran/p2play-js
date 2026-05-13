import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling, FakeRTCPeerConnection } from './helpers/fakes';

describe('PeerManager ICE candidate handling', () => {
  beforeEach(() => { installFakeRTC(); });

  it('buffers ICE candidate for unknown peer', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerIce({ candidate: 'c1', sdpMid: '0' } as any, 'B');

    const buffered = (pm as any).bufferedRemoteIce.get('B');
    expect(buffered).toBeDefined();
    expect(buffered.length).toBe(1);
    pm.dispose();
  });

  it('buffers ICE candidate for known peer without remoteDescription', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));

    const peerB = pm.getPeer('B')!;
    expect(peerB).toBeDefined();
    expect(peerB.rtc.remoteDescription).toBeNull();

    signaling.__triggerIce({ candidate: 'c2', sdpMid: '0' } as any, 'B');
    await new Promise(r => setImmediate(r));

    const buffered = (pm as any).bufferedRemoteIce.get('B');
    expect(buffered).toBeDefined();
    expect(buffered.length).toBeGreaterThanOrEqual(1);
    pm.dispose();
  });

  it('calls addIceCandidate for known peer with remoteDescription', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));

    const peerB = pm.getPeer('B')!;
    (peerB.rtc as any).remoteDescription = { type: 'answer', sdp: '' };

    signaling.__triggerIce({ candidate: 'c3', sdpMid: '0' } as any, 'B');
    await new Promise(r => setImmediate(r));

    const rtc = peerB.rtc as unknown as FakeRTCPeerConnection;
    expect(rtc.addedIceCandidates.some(c => (c as any).candidate === 'c3')).toBe(true);
    pm.dispose();
  });

  it('flushBufferedIce applies buffered candidates when peer is created from offer', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerIce({ candidate: 'buffered1', sdpMid: '0' } as any, 'A');
    signaling.__triggerIce({ candidate: 'buffered2', sdpMid: '0' } as any, 'A');
    expect((pm as any).bufferedRemoteIce.get('A')?.length).toBe(2);

    signaling.__triggerDesc({ type: 'offer', sdp: '' }, 'A');
    await new Promise(r => setImmediate(r));

    expect((pm as any).bufferedRemoteIce.has('A')).toBe(false);
    const rtc = pm.getPeer('A')?.rtc as unknown as FakeRTCPeerConnection;
    expect(rtc).toBeDefined();
    expect(rtc.addedIceCandidates.length).toBeGreaterThanOrEqual(2);
    pm.dispose();
  });
});

describe('PeerManager pending offer timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeRTC({ connectOnSetLocalDescription: false });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('removes pending initiator after 30s timeout', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0);

    expect((pm as any).pendingInitiators.has('B')).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect((pm as any).pendingInitiators.has('B')).toBe(false);
    pm.dispose();
  });

  it('logs debug on timeout when debug.enabled', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, { enabled: true });
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('pending offer timeout'), 'B');
    spy.mockRestore();
    pm.dispose();
  });
});

describe('PeerManager onicecandidate', () => {
  beforeEach(() => { installFakeRTC(); });

  it('sends ICE candidate to signaling when onicecandidate fires', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const sentIce: any[] = [];
    signaling.sendIceCandidate = async (c: any, to: any) => { sentIce.push({ c, to }); };
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));

    const peer = pm.getPeer('B')!;
    const rtc = peer.rtc as unknown as FakeRTCPeerConnection;
    rtc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local-ice' }) } } as any);

    expect(sentIce.length).toBe(1);
    expect(sentIce[0].c.candidate).toBe('local-ice');
    pm.dispose();
  });

  it('ignores onicecandidate with null candidate (end-of-candidates)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const sentIce: any[] = [];
    signaling.sendIceCandidate = async (c: any) => { sentIce.push(c); };
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));

    const peer = pm.getPeer('B')!;
    const rtc = peer.rtc as unknown as FakeRTCPeerConnection;
    rtc.onicecandidate?.({ candidate: null } as any);

    expect(sentIce.length).toBe(0);
    pm.dispose();
  });
});

describe('PeerManager dispose idempotent', () => {
  beforeEach(() => { installFakeRTC(); });

  it('second dispose() is a no-op', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    pm.dispose();
    expect(() => pm.dispose()).not.toThrow();
  });
});

describe('PeerManager ping loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeRTC();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends pings every 2s on unreliable channel', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0);

    const peerB = pm.getPeer('B')!;
    expect(peerB).toBeDefined();
    const dc = peerB.dcUnreliable as any;
    const before = dc.sent.length;

    await vi.advanceTimersByTimeAsync(2000);

    const pings = dc.sent.slice(before).filter((s: string) => {
      try { return JSON.parse(s).t === 'ping'; } catch { return false; }
    });
    expect(pings.length).toBeGreaterThanOrEqual(1);
    pm.dispose();
  });
});

describe('PeerManager defensive branches', () => {
  it('ignores answer when signalingState is not have-local-offer', async () => {
    installFakeRTC({ connectOnSetLocalDescription: false });
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));

    const pending = (pm as any).pendingInitiators.get('B');
    expect(pending).toBeDefined();
    pending.rtc.signalingState = 'stable';

    signaling.__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise(r => setImmediate(r));

    const peerB = pm.getPeer('B');
    expect(peerB).toBeDefined();
    const rtc = peerB!.rtc as unknown as FakeRTCPeerConnection;
    expect(rtc.remoteDescription).toBeNull();
    pm.dispose();
  });

  it('ignores offer when peer is already connected', async () => {
    installFakeRTC();
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerDesc({ type: 'offer', sdp: '' }, 'A');
    await new Promise(r => setImmediate(r));

    expect(pm.getPeer('A')).toBeDefined();
    expect(pm.getPeer('A')!.rtc.connectionState).toBe('connected');

    signaling.__triggerDesc({ type: 'offer', sdp: '' }, 'A');
    await new Promise(r => setImmediate(r));

    expect(pm.getPeerIds().filter(id => id === 'A').length).toBe(1);
    pm.dispose();
  });

  it('roster cleanup removes pending initiators no longer in roster', async () => {
    installFakeRTC({ connectOnSetLocalDescription: false });
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    signaling.__triggerRoster(['A', 'B']);
    await new Promise(r => setImmediate(r));
    expect((pm as any).pendingInitiators.has('B')).toBe(true);

    signaling.__triggerRoster(['A']);
    expect((pm as any).pendingInitiators.has('B')).toBe(false);
    pm.dispose();
  });
});
