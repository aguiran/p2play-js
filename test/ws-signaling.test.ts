import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketSignaling } from '../src/net/WebSocketSignaling';

class FakeWebSocket {
  readyState = 0;
  url: string;
  private listeners: Record<string, Function[]> = {};
  sent: string[] = [];

  constructor(url: string) { this.url = url; }

  addEventListener(event: string, cb: Function) {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string) { this.sent.push(data); }

  close() {
    this.readyState = 3;
    this.listeners['close']?.forEach(cb => cb());
  }

  _open() {
    this.readyState = 1;
    this.listeners['open']?.forEach(cb => cb());
  }

  _receive(data: string) {
    this.listeners['message']?.forEach(cb => cb({ data }));
  }
}

function installFakeWS(): FakeWebSocket[] {
  const instances: FakeWebSocket[] = [];
  (globalThis as any).WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
  return instances;
}

describe('WebSocketSignaling', () => {
  let instances: FakeWebSocket[];

  beforeEach(() => { instances = installFakeWS(); });
  afterEach(() => { delete (globalThis as any).WebSocket; });

  function createSignaling(opts?: { reconnect?: boolean }) {
    const sig = new WebSocketSignaling('P1', 'room42', 'ws://fake', opts);
    const ws = instances[instances.length - 1];
    ws._open();
    return { sig, ws };
  }

  it('register sends registration message', async () => {
    const { sig, ws } = createSignaling();
    await sig.register();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg).toEqual(expect.objectContaining({
      roomId: 'room42',
      from: 'P1',
      kind: 'register',
      announce: true,
    }));
    sig.close();
  });

  it('register includes roomToken in payload when provided', async () => {
    const sig = new WebSocketSignaling('P1', 'room42', 'ws://fake', { roomToken: 'jwt.here' });
    const ws = instances[instances.length - 1];
    ws._open();
    await sig.register();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.roomToken).toBe('jwt.here');
    expect(msg.kind).toBe('register');
    sig.close();
  });

  it('announce sends SDP description', async () => {
    const { sig, ws } = createSignaling();
    await sig.announce({ type: 'offer', sdp: 'test-sdp' }, 'P2');
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.kind).toBe('desc');
    expect(msg.payload).toEqual({ type: 'offer', sdp: 'test-sdp' });
    expect(msg.to).toBe('P2');
    expect(msg.roomId).toBe('room42');
    sig.close();
  });

  it('sendIceCandidate sends ICE candidate', async () => {
    const { sig, ws } = createSignaling();
    await sig.sendIceCandidate({ candidate: 'ice1', sdpMid: '0' } as any, 'P2');
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.kind).toBe('ice');
    expect(msg.payload.candidate).toBe('ice1');
    expect(msg.to).toBe('P2');
    sig.close();
  });

  it('onRemoteDescription fires on desc message from another peer', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onRemoteDescription((desc, from) => received.push({ desc, from }));

    ws._receive(JSON.stringify({
      kind: 'desc', roomId: 'room42', from: 'P2',
      payload: { type: 'offer', sdp: 'remote-sdp' },
    }));

    expect(received.length).toBe(1);
    expect(received[0].from).toBe('P2');
    expect(received[0].desc.sdp).toBe('remote-sdp');
    sig.close();
  });

  it('onIceCandidate fires on ice message from another peer', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onIceCandidate((candidate, from) => received.push({ candidate, from }));

    ws._receive(JSON.stringify({
      kind: 'ice', roomId: 'room42', from: 'P2',
      payload: { candidate: 'remote-ice', sdpMid: '0' },
    }));

    expect(received.length).toBe(1);
    expect(received[0].candidate.candidate).toBe('remote-ice');
    sig.close();
  });

  it('onRoster fires on roster system message', async () => {
    const { sig, ws } = createSignaling();
    const rosters: string[][] = [];
    sig.onRoster((r) => rosters.push(r));

    ws._receive(JSON.stringify({
      sys: 'roster', roomId: 'room42', roster: ['P1', 'P2', 'P3'],
    }));

    expect(rosters.length).toBe(1);
    expect(rosters[0]).toEqual(['P1', 'P2', 'P3']);
    sig.close();
  });

  it('filters messages from a different roomId', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onRemoteDescription((desc, from) => received.push({ desc, from }));

    ws._receive(JSON.stringify({
      kind: 'desc', roomId: 'other-room', from: 'P2',
      payload: { type: 'offer', sdp: 'wrong-room' },
    }));

    expect(received.length).toBe(0);
    sig.close();
  });

  it('filters messages from self', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onRemoteDescription((desc, from) => received.push({ desc, from }));

    ws._receive(JSON.stringify({
      kind: 'desc', roomId: 'room42', from: 'P1',
      payload: { type: 'offer', sdp: 'self' },
    }));

    expect(received.length).toBe(0);
    sig.close();
  });

  it('handles non-string message data gracefully', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onRemoteDescription((desc, from) => received.push({ desc, from }));
    ws._receive(JSON.stringify({}));
    expect(received.length).toBe(0);
  });

  it('onRoster handles non-array roster gracefully', async () => {
    const { sig, ws } = createSignaling();
    const rosters: string[][] = [];
    sig.onRoster((r) => rosters.push(r));

    ws._receive(JSON.stringify({
      sys: 'roster', roomId: 'room42', roster: 'not-an-array',
    }));

    expect(rosters.length).toBe(1);
    expect(rosters[0]).toEqual([]);
    sig.close();
  });

  it('ignores message without from field (non-roster)', async () => {
    const { sig, ws } = createSignaling();
    const received: any[] = [];
    sig.onRemoteDescription((desc, from) => received.push({ desc, from }));
    ws._receive(JSON.stringify({
      kind: 'desc', roomId: 'room42',
      payload: { type: 'offer', sdp: 'test' },
    }));
    expect(received.length).toBe(0);
    sig.close();
  });

  it('close cleans up handlers and closes WS', async () => {
    const { sig, ws } = createSignaling();
    sig.onRemoteDescription(() => {});
    sig.onIceCandidate(() => {});
    sig.onRoster(() => {});

    sig.close();

    expect(ws.readyState).toBe(3);
    ws._receive(JSON.stringify({
      kind: 'desc', roomId: 'room42', from: 'P2',
      payload: { type: 'offer', sdp: 'after-close' },
    }));
  });

  it('with reconnect false (default), close does not trigger reconnect', async () => {
    const { sig, ws } = createSignaling();
    expect(instances.length).toBe(1);
    ws.close();
    await new Promise((r) => setImmediate(r));
    expect(instances.length).toBe(1);
    sig.close();
  });

  it('with reconnect true, close() explicit prevents reconnect after network close', async () => {
    vi.useFakeTimers();
    const { sig, ws } = createSignaling({ reconnect: true });
    sig.setReconnectCallbacks(() => {}, () => {});
    ws.close();
    await vi.advanceTimersByTimeAsync(1000);
    sig.close();
    await vi.advanceTimersByTimeAsync(50000);
    expect(instances.length).toBe(1);
    vi.useRealTimers();
  });

  it('with reconnect true, onDisconnect and onReconnect are called on close then reopen', async () => {
    vi.useFakeTimers();
    const { sig, ws } = createSignaling({ reconnect: true });
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    sig.setReconnectCallbacks(onDisconnect, onReconnect);
    await sig.register();
    expect(ws.sent.some((s) => JSON.parse(s).kind === 'register')).toBe(true);

    ws.close();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    const ws2 = instances[instances.length - 1];
    expect(instances.length).toBe(2);
    ws2._open();
    await vi.runAllTimersAsync();

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(ws2.sent.some((s) => JSON.parse(s).kind === 'register')).toBe(true);
    sig.close();
    vi.useRealTimers();
  });
});
