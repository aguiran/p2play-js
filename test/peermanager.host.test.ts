import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

type PlayerId = string;

describe('PeerManager host election', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected' });
  });

  it('elects smallest playerId as host and updates on topology change', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    let lastHost: PlayerId | undefined;
    bus.on('hostChange', (h) => { lastHost = h; });

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['B', 'C']);
    (signaling as any).__triggerOffer('C');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'C');
    ;(pm as any).electHost?.();
    expect(lastHost).toBe('B');

    (signaling as any).__triggerRoster(['A', 'B', 'C']);
    (signaling as any).__triggerOffer('A');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'A');
    await new Promise((r) => setImmediate(r));
    ;(pm as any).electHost?.();
    expect(pm.getHostId()).toBe('A');
    expect(lastHost).toBe('A');
  });

  it('elects host by numeric order when IDs are digit-only ("2" before "10")', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('2');
    const pm = new PeerManager(bus, signaling as any);
    let lastHost: PlayerId | undefined;
    bus.on('hostChange', (h) => { lastHost = h; });

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['2', '10']);
    (signaling as any).__triggerOffer('10');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, '10');
    await new Promise((r) => setImmediate(r));
    ;(pm as any).electHost?.();

    expect(pm.getHostId()).toBe('2');
    expect(lastHost).toBe('2');
  });

  it('elects host by strict binary order for non-numeric IDs ("A" before "B")', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('B');
    const pm = new PeerManager(bus, signaling as any);
    bus.on('hostChange', () => {});

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerOffer('A');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'A');
    await new Promise((r) => setImmediate(r));
    ;(pm as any).electHost?.();

    expect(pm.getHostId()).toBe('A');
  });

  it('uses strict binary order for mixed numeric and non-numeric IDs ("2" vs "A")', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    bus.on('hostChange', () => {});

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['2', 'A']);
    (signaling as any).__triggerOffer('2');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, '2');
    await new Promise((r) => setImmediate(r));
    ;(pm as any).electHost?.();

    expect(pm.getHostId()).toBe('2');
  });

  it('uses string tie-break when numeric value is equal ("02" vs "2")', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('2');
    const pm = new PeerManager(bus, signaling as any);
    bus.on('hostChange', () => {});

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['02', '2']);
    (signaling as any).__triggerOffer('02');
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, '02');
    await new Promise((r) => setImmediate(r));
    ;(pm as any).electHost?.();

    expect(pm.getHostId()).toBe('02');
  });

  it('elects same host regardless of roster order (stability)', async () => {
    const bus1 = new EventBus();
    const signaling1 = createMockSignaling('5');
    const pm1 = new PeerManager(bus1, signaling1 as any);
    await pm1.createOrJoin();
    (signaling1 as any).__triggerRoster(['2', '10', '5']);
    (signaling1 as any).__triggerOffer('2');
    (signaling1 as any).__triggerDesc({ type: 'answer', sdp: '' }, '2');
    (signaling1 as any).__triggerOffer('10');
    (signaling1 as any).__triggerDesc({ type: 'answer', sdp: '' }, '10');
    await new Promise((r) => setImmediate(r));
    ;(pm1 as any).electHost?.();
    const host1 = pm1.getHostId();

    const bus2 = new EventBus();
    const signaling2 = createMockSignaling('5');
    const pm2 = new PeerManager(bus2, signaling2 as any);
    await pm2.createOrJoin();
    (signaling2 as any).__triggerRoster(['10', '5', '2']);
    (signaling2 as any).__triggerOffer('10');
    (signaling2 as any).__triggerDesc({ type: 'answer', sdp: '' }, '10');
    (signaling2 as any).__triggerOffer('2');
    (signaling2 as any).__triggerDesc({ type: 'answer', sdp: '' }, '2');
    await new Promise((r) => setImmediate(r));
    ;(pm2 as any).electHost?.();
    const host2 = pm2.getHostId();

    expect(host1).toBe('2');
    expect(host2).toBe('2');
  });
});
