import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { installFakeRTC, createMockSignaling } from './helpers/fakes';

describe('PeerManager timing options', () => {
  beforeEach(() => {
    installFakeRTC();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses custom pendingOfferTimeoutMs when timing option is provided', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const bus = new EventBus();
    const signaling = createMockSignaling('A');
    const pm = new PeerManager(
      bus,
      signaling as any,
      'json',
      undefined,
      undefined,
      undefined,
      undefined,
      { pendingOfferTimeoutMs: 5000, pingIntervalMs: 3000 }
    );

    await pm.createOrJoin();
    (signaling as any).__triggerRoster(['A', 'B']);

    await vi.advanceTimersByTimeAsync(0);

    const timeoutCall = setTimeoutSpy.mock.calls.find((c) => c[1] === 5000);
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![1]).toBe(5000);

    pm.dispose();
    setTimeoutSpy.mockRestore();
  });
});
