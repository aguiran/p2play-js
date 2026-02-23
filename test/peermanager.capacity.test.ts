import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager capacity', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  it('emits maxCapacityReached when initiating beyond capacity', async () => {
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(bus, signaling as any, 'json', undefined, {}, { strategy: 'coalesce-moves', thresholdBytes: 262144 }, 2);

    let emittedMax: number | undefined;
    bus.on('maxCapacityReached', (max) => { emittedMax = max; });

    await pm.createOrJoin();
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
    (signaling as any).__triggerRoster(['A', 'B']);
    (signaling as any).__triggerDesc({ type: 'offer', sdp: '' }, 'C');

    expect(count).toBeGreaterThan(0);
  });
});
