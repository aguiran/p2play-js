import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import type { NetMessage } from '../src/types';
import { FakeDataChannel, FakeRTCPeerConnection, installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager dual-channel routing', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  function setupWithPeer() {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    return { bus, signaling, pm };
  }

  async function connectPeer(pm: PeerManager, signaling: ReturnType<typeof createMockSignaling>) {
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    return (pm as any).peers.get('B');
  }

  it('routes move messages to the unreliable channel', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 1, y: 2 }, seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcU.sent.length).toBe(1);
    expect(dcR.sent.length).toBe(0);
  });

  it('routes inventory messages to the reliable channel', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'inventory', from: 'A', ts: 1, items: [], seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });

  it('routes state_full messages to the reliable channel', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'state_full', from: 'A', ts: 1, state: {}, seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });

  it('routes state_delta messages to the reliable channel', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'state_delta', from: 'A', ts: 1, delta: { tick: 0, changes: [] }, seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });

  it('routes payload messages to the reliable channel by default', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'payload', from: 'A', ts: 1, payload: { test: true }, seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });

  it('routes transfer messages to the reliable channel', async () => {
    const { pm, signaling } = setupWithPeer();
    const peer = await connectPeer(pm, signaling);
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'transfer', from: 'A', ts: 1, to: 'B', item: { id: 'x', type: 'y', quantity: 1 }, seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });
});

describe('PeerManager dual-channel: unreliable flag override', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  it('forces payload to unreliable channel when { unreliable: true }', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'payload', from: 'A', ts: 1, payload: { fast: true }, seq: 1 } as any;
    pm.broadcast(msg, { unreliable: true });

    expect(dcU.sent.length).toBe(1);
    expect(dcR.sent.length).toBe(0);
  });

  it('forces inventory to unreliable channel when { unreliable: true }', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'inventory', from: 'A', ts: 1, items: [], seq: 1 } as any;
    pm.broadcast(msg, { unreliable: true });

    expect(dcU.sent.length).toBe(1);
    expect(dcR.sent.length).toBe(0);
  });

  it('send() with unreliable flag uses unreliable channel', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'payload', from: 'A', ts: 1, payload: {}, seq: 1 } as any;
    pm.send('B', msg, { unreliable: true });

    expect(dcU.sent.length).toBe(1);
    expect(dcR.sent.length).toBe(0);
  });
});

describe('PeerManager dual-channel: ondatachannel by label (receiver side)', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('receiver assigns channels by label via ondatachannel', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'offer', sdp: '' }, 'A');
    await new Promise((r) => setImmediate(r));

    const peerA = (pm as any).peers.get('A');
    expect(peerA).toBeDefined();
    const rtc = peerA.rtc as FakeRTCPeerConnection;

    const fakeUnreliable = new FakeDataChannel('game-unreliable');
    const fakeReliable = new FakeDataChannel('game-reliable');
    rtc.ondatachannel?.({ channel: fakeUnreliable as any });
    rtc.ondatachannel?.({ channel: fakeReliable as any });

    expect(peerA.dcUnreliable).toBe(fakeUnreliable);
    expect(peerA.dcReliable).toBe(fakeReliable);
  });

  it('ignores channels with unknown labels', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();

    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'offer', sdp: '' }, 'A');
    await new Promise((r) => setImmediate(r));

    const peerA = (pm as any).peers.get('A');
    expect(peerA).toBeDefined();
    const rtc = peerA.rtc as FakeRTCPeerConnection;

    const unknown = new FakeDataChannel('unknown-channel');
    rtc.ondatachannel?.({ channel: unknown as any });

    expect(peerA.dcUnreliable).toBeUndefined();
    expect(peerA.dcReliable).toBeUndefined();
  });
});

describe('PeerManager dual-channel: outbox flush by channel', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  it('flushes outboxUnreliable when dcUnreliable opens', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    dcU.readyState = 'closed';
    dcU.sent = [];

    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 5, y: 5 }, seq: 1 } as any;
    pm.broadcast(msg);
    expect(peer.outboxUnreliable?.length).toBe(1);
    expect(dcU.sent.length).toBe(0);

    dcU.readyState = 'open';
    dcU.onopen?.();
    expect(peer.outboxUnreliable?.length).toBe(0);
    expect(dcU.sent.length).toBe(1);
  });

  it('flushes outboxReliable when dcReliable opens', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    const peer = (pm as any).peers.get('B');
    const dcR = peer.dcReliable as FakeDataChannel;
    dcR.readyState = 'closed';
    dcR.sent = [];

    const msg: NetMessage = { t: 'inventory', from: 'A', ts: 1, items: [], seq: 1 } as any;
    pm.broadcast(msg);
    expect(peer.outboxReliable?.length).toBe(1);
    expect(dcR.sent.length).toBe(0);

    dcR.readyState = 'open';
    dcR.onopen?.();
    expect(peer.outboxReliable?.length).toBe(0);
    expect(dcR.sent.length).toBe(1);
  });

  it('does not flush unreliable outbox when reliable channel opens', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.readyState = 'closed';
    dcU.sent = [];
    dcR.sent = [];

    const msg: NetMessage = { t: 'move', from: 'A', ts: 1, position: { x: 1, y: 1 }, seq: 1 } as any;
    pm.broadcast(msg);
    expect(peer.outboxUnreliable?.length).toBe(1);

    dcR.onopen?.();
    expect(peer.outboxUnreliable?.length).toBe(1);
    expect(dcU.sent.length).toBe(0);
  });
});

describe('PeerManager dual-channel: backpressure not applied to reliable', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  it('reliable messages are sent even when bufferedAmount exceeds threshold', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'drop-moves', thresholdBytes: 1 });
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    const peer = (pm as any).peers.get('B');
    const dcR = peer.dcReliable as FakeDataChannel;
    dcR.bufferedAmount = 999999;
    dcR.sent = [];

    const msg: NetMessage = { t: 'inventory', from: 'A', ts: 1, items: [], seq: 1 } as any;
    pm.broadcast(msg);

    expect(dcR.sent.length).toBe(1);
  });
});

describe('PeerManager dual-channel: pong sent via unreliable', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected', connectOnSetLocalDescription: false });
  });

  it('pong is sent via dcUnreliable', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    const peer = (pm as any).peers.get('B');
    const dcU = peer.dcUnreliable as FakeDataChannel;
    const dcR = peer.dcReliable as FakeDataChannel;
    dcU.sent = [];
    dcR.sent = [];

    (pm as any).onMessage('B', JSON.stringify({ t: 'ping', ts: 12345 }));

    expect(dcU.sent.length).toBe(1);
    expect(dcR.sent.length).toBe(0);
    const pong = JSON.parse(dcU.sent[0] as string);
    expect(pong.t).toBe('pong');
    expect(pong.ts).toBe(12345);
  });
});

describe('PeerManager createOfferTo creates both channels', () => {
  beforeEach(() => {
    installFakeRTC({ connectOnSetLocalDescription: false });
  });

  it('initiator creates both game-unreliable and game-reliable channels', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);

    const pending = (pm as any).pendingInitiators.get('B');
    expect(pending).toBeDefined();
    expect(pending.dcUnreliable).toBeDefined();
    expect(pending.dcReliable).toBeDefined();
    expect(pending.dcUnreliable.label).toBe('game-unreliable');
    expect(pending.dcReliable.label).toBe('game-reliable');
  });
});
