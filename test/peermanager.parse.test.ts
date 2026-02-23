import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager parse robustness', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected' });
  });

  it('does not crash and does not emit netMessage on invalid JSON string', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    let netMessageCount = 0;
    bus.on('netMessage', () => { netMessageCount++; });

    (pm as any).onMessage('B', 'not json');
    (pm as any).onMessage('B', '{ invalid');
    (pm as any).onMessage('B', '');
    (pm as any).onMessage('B', 'null');

    expect(netMessageCount).toBe(0);
  });

  it('does not emit netMessage on truncated or malformed JSON', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    let netMessageCount = 0;
    bus.on('netMessage', () => { netMessageCount++; });

    (pm as any).onMessage('B', '{"t":"move"'); // truncated
    (pm as any).onMessage('B', '{"t":}');     // invalid

    expect(netMessageCount).toBe(0);
  });

  it('ignores invalid binary payload without emitting netMessage', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    let netMessageCount = 0;
    bus.on('netMessage', () => { netMessageCount++; });

    (pm as any).onMessage('B', new ArrayBuffer(4));

    expect(netMessageCount).toBe(0);
  });
});

describe('PeerManager anti-usurpation (transport identity over payload)', () => {
  beforeEach(() => {
    installFakeRTC({ initialConnectionState: 'connected' });
  });

  it('emits netMessage with from = transport peer id when payload has forged from (string)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    let received: any = null;
    bus.on('netMessage', (msg: any) => { received = msg; });

    const forgedPayload = JSON.stringify({ t: 'move', from: 'attacker', ts: 1, position: { x: 0, y: 0 }, seq: 1 });
    (pm as any).onMessage('B', forgedPayload);

    expect(received).not.toBeNull();
    expect(received.from).toBe('B');
    expect(received.t).toBe('move');
  });

  it('emits netMessage with from = transport peer id when payload has forged from (binary)', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any);
    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'answer', sdp: '' }, 'B');

    let received: any = null;
    bus.on('netMessage', (msg: any) => { received = msg; });

    const payload = JSON.stringify({ t: 'move', from: 'attacker', ts: 1, position: { x: 0, y: 0 }, seq: 1 });
    const binary = new TextEncoder().encode(payload).buffer;
    (pm as any).onMessage('B', binary);

    expect(received).not.toBeNull();
    expect(received.from).toBe('B');
    expect(received.t).toBe('move');
  });
});
