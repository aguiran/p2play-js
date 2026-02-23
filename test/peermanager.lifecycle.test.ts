import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling, FakeRTCPeerConnection } from './helpers/fakes';

type PlayerId = string;

describe('PeerManager lifecycle', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('emits peerJoin and hostChange when a peer connects (roster + offer/answer)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    const joins: PlayerId[] = [];
    const hosts: PlayerId[] = [];
    bus.on('peerJoin', (id: PlayerId) => joins.push(id));
    bus.on('hostChange', (id: PlayerId) => hosts.push(id));

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerOffer('B');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise((r) => setImmediate(r));

    expect(joins).toContain('B');
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    expect(pm.getPeerIds()).toContain('B');
  });

  it('emits peerLeave and hostChange when peer connection goes closed', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    const leaves: PlayerId[] = [];
    let lastHost: PlayerId | undefined;
    bus.on('peerLeave', (id: PlayerId) => leaves.push(id));
    bus.on('hostChange', (h: PlayerId) => { lastHost = h; });

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['B', 'A']);
    (signaling as any).__triggerOffer('A');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'A');
    await new Promise((r) => setImmediate(r));

    expect(pm.getHostId()).toBe('A');
    const peerA = (pm as any).peers.get('A');
    expect(peerA).toBeDefined();
    const rtc = peerA.rtc as FakeRTCPeerConnection;
    rtc.connectionState = 'closed';
    rtc.onconnectionstatechange?.();

    expect(leaves).toContain('A');
    expect(pm.getPeerIds()).not.toContain('A');
    expect(lastHost).toBe('B');
  });

  it('emits peerLeave when roster is updated and peer is removed (leave roster)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    const leaves: PlayerId[] = [];
    bus.on('peerLeave', (id: PlayerId) => leaves.push(id));

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerOffer('B');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise((r) => setImmediate(r));

    expect(pm.getPeerIds()).toContain('B');

    (signaling as any).__triggerRoster(['A']);

    expect(leaves).toContain('B');
    expect(pm.getPeerIds()).not.toContain('B');
  });
});
