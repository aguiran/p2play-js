import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager handleSignalingDisconnect', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('clears peers and emits peerLeave for each when called', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    const leaves: string[] = [];
    bus.on('peerLeave', (id: string) => leaves.push(id));

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise((r) => setImmediate(r));

    expect(pm.getPeerIds()).toContain('B');

    pm.handleSignalingDisconnect();

    expect(pm.getPeerIds()).toEqual([]);
    expect(leaves).toContain('B');
  });

  it('after disconnect, new roster creates fresh offers (no stale peers block createOfferTo)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise((r) => setImmediate(r));

    expect(pm.getPeerIds()).toContain('B');

    pm.handleSignalingDisconnect();
    expect(pm.getPeerIds()).toEqual([]);

    (signaling as any).__triggerRoster(['A', 'B']);
    await new Promise((r) => setImmediate(r));

    expect(pm.getPeerIds()).toContain('B');
    expect(pm.getPeerIds().length).toBe(1);
  });

  it('does nothing if already disposed', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    const leaves: string[] = [];
    bus.on('peerLeave', (id: string) => leaves.push(id));

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');
    await new Promise((r) => setImmediate(r));

    (pm as any).dispose();
    leaves.length = 0;

    pm.handleSignalingDisconnect();

    expect(leaves).toEqual([]);
  });
});
