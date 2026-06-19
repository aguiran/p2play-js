import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { PeerManager } from '../src/net/PeerManager';
import { VoiceManager } from '../src/voice/VoiceManager';
import {
  installFakeRTC,
  installFakeGetUserMedia,
  createMockSignaling,
  linkMockSignalings,
  FakeRTCPeerConnection,
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakeDataChannel,
} from './helpers/fakes';

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

interface Node {
  id: string;
  sig: ReturnType<typeof createMockSignaling>;
  bus: EventBus;
  pm: PeerManager;
  voice: VoiceManager;
}

async function setupRoom(ids: string[]): Promise<Node[]> {
  const sigs = ids.map((id) => createMockSignaling(id));
  linkMockSignalings(sigs);
  const nodes: Node[] = sigs.map((sig) => {
    const bus = new EventBus();
    const pm = new PeerManager(bus, sig as any);
    const voice = new VoiceManager(pm, bus);
    return { id: sig.localId, sig, bus, pm, voice };
  });
  for (const n of nodes) await n.pm.createOrJoin();
  for (const n of nodes) n.sig.__triggerRoster(ids);
  await flush();
  return nodes;
}

function rtcOf(node: Node, peerId: string): FakeRTCPeerConnection {
  return node.pm.getPeer(peerId)!.rtc as unknown as FakeRTCPeerConnection;
}

describe('VoiceManager — talk', () => {
  beforeEach(() => { installFakeRTC(); });

  it('SA1: start(talk) resolves, negotiates sendrecv on both sides, DataChannels untouched', async () => {
    const gum = installFakeGetUserMedia();
    const [a, b] = await setupRoom(['A', 'B']);
    const dcBefore = a.pm.getPeer('B')!.dcReliable;

    await a.voice.start('B', { mode: 'talk' });

    const trA = rtcOf(a, 'B').getTransceivers()[0];
    expect(trA.currentDirection).toBe('sendrecv');
    expect(trA.sender.track).not.toBeNull();
    // Remote auto-answered with its mic attached (no app-side start needed)
    const trB = rtcOf(b, 'A').getTransceivers()[0];
    expect(trB.currentDirection).toBe('sendrecv');
    expect(trB.sender.track).not.toBeNull();
    expect(gum.calls.length).toBe(2); // one mic per side
    // Remote adopted the link so stop()/cleanup work
    expect(b.voice.getActiveLinks()).toEqual([{ peerId: 'A', mode: 'talk', state: 'connected' }]);
    // DataChannels unaffected
    expect(a.pm.getPeer('B')!.dcReliable).toBe(dcBefore);
    expect(dcBefore?.readyState).toBe('open');
  });

  it('emits state connecting then connected, and remoteStream when the track arrives', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const states: string[] = [];
    const streams: unknown[] = [];
    a.voice.on('state', (_pid, s) => states.push(s));
    a.voice.on('remoteStream', (pid, stream) => streams.push([pid, stream]));

    await a.voice.start('B', { mode: 'talk' });
    expect(states).toEqual(['connecting', 'connected']);

    const remote = new FakeMediaStream([new FakeMediaStreamTrack('audio')]);
    rtcOf(a, 'B').ontrack?.({ track: remote.getAudioTracks()[0], streams: [remote] });
    expect(streams).toEqual([['B', remote]]);
  });

  it('uses the provided localStream instead of getUserMedia (talk only)', async () => {
    const gum = installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const customTrack = new FakeMediaStreamTrack('audio');
    const custom = new FakeMediaStream([customTrack]);

    await a.voice.start('B', { mode: 'talk', localStream: custom as unknown as MediaStream });

    expect(rtcOf(a, 'B').getTransceivers()[0].sender.track).toBe(customTrack);
    expect(gum.calls.length).toBe(1); // only the remote side acquired a mic
    // App-provided tracks are never stopped by the lib
    a.voice.stop('B');
    expect(customTrack.readyState).toBe('live');
  });

  it('SA5: mic permission denied -> start(talk) rejects, error event, DataChannels intact', async () => {
    installFakeGetUserMedia({ deny: true });
    const [a] = await setupRoom(['A', 'B']);
    const errors: Error[] = [];
    a.voice.on('error', (_pid, e) => errors.push(e));

    await expect(a.voice.start('B', { mode: 'talk' })).rejects.toThrow(/Permission denied/);
    expect(errors.length).toBe(1);
    expect(a.voice.getActiveLinks()).toEqual([]);
    expect(a.pm.getPeer('B')!.dcReliable?.readyState).toBe('open');
  });

  it('answerer degrades gracefully when its own mic is denied (negotiation still completes)', async () => {
    // Both sides share the same fake gUM: allow the first call (A), deny afterwards (B)
    let calls = 0;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            calls++;
            if (calls > 1) throw new Error('Permission denied');
            return new FakeMediaStream([new FakeMediaStreamTrack('audio')]);
          },
        },
      },
      configurable: true,
      writable: true,
    });
    const [a, b] = await setupRoom(['A', 'B']);
    const errorsB: Error[] = [];
    b.voice.on('error', (_pid, e) => errorsB.push(e));

    await a.voice.start('B', { mode: 'talk' });

    expect(errorsB.length).toBe(1);
    const trB = rtcOf(b, 'A').getTransceivers()[0];
    expect(trB.direction).toBe('recvonly'); // B receives A but cannot send
    expect(trB.sender.track).toBeNull();
  });

  it('rejects start() towards an unknown or disconnected peer', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await expect(a.voice.start('Z', { mode: 'talk' })).rejects.toThrow(/no connected peer/);
  });

  it('rejects start() when the remote refuses the link (negotiated inactive)', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const states: string[] = [];
    a.voice.on('state', (_pid, s) => states.push(s));
    rtcOf(a, 'B').negotiatedDirectionOverride = 'inactive';

    await expect(a.voice.start('B', { mode: 'talk' })).rejects.toThrow(/rejected/);
    expect(states).toContain('failed');
    expect(a.voice.getActiveLinks()).toEqual([]);
  });
});

describe('VoiceManager — listen', () => {
  beforeEach(() => { installFakeRTC(); });

  it('SA2: C alone starts listen towards A and B; both auto-respond sendonly; A<->B talk untouched', async () => {
    const gum = installFakeGetUserMedia();
    const [a, b, c] = await setupRoom(['A', 'B', 'C']);

    await a.voice.start('B', { mode: 'talk' }); // A<->B bidirectional
    expect(gum.calls.length).toBe(2);

    // Only C calls start; A and B must not need an app-side start
    await c.voice.start('A', { mode: 'listen' });
    await c.voice.start('B', { mode: 'listen' });

    // C: two recvonly links, no mic acquired on C
    expect(rtcOf(c, 'A').getTransceivers()[0].currentDirection).toBe('recvonly');
    expect(rtcOf(c, 'B').getTransceivers()[0].currentDirection).toBe('recvonly');
    expect(gum.calls.length).toBe(2); // C never called getUserMedia

    // A and B auto-answered sendonly towards C, reusing their existing shared mic track
    const trAtoC = rtcOf(a, 'C').getTransceivers()[0];
    const trAtoB = rtcOf(a, 'B').getTransceivers()[0];
    expect(trAtoC.currentDirection).toBe('sendonly');
    expect(trAtoC.sender.track).toBe(trAtoB.sender.track); // same MediaStreamTrack, no clone
    expect(rtcOf(b, 'C').getTransceivers()[0].currentDirection).toBe('sendonly');

    // A<->B link still bidirectional
    expect(trAtoB.currentDirection).toBe('sendrecv');
    expect(rtcOf(b, 'A').getTransceivers()[0].currentDirection).toBe('sendrecv');

    // C receives both remote streams (two remoteStream events)
    const received: string[] = [];
    c.voice.on('remoteStream', (pid) => received.push(pid));
    const sA = new FakeMediaStream();
    const sB = new FakeMediaStream();
    rtcOf(c, 'A').ontrack?.({ track: sA.getAudioTracks()[0], streams: [sA] });
    rtcOf(c, 'B').ontrack?.({ track: sB.getAudioTracks()[0], streams: [sB] });
    expect(received).toEqual(['A', 'B']);

    // DataChannels intact (initiator side, where fakes create them)
    for (const [node, peer] of [[a, 'B'], [a, 'C'], [b, 'C']] as Array<[Node, string]>) {
      expect(node.pm.getPeer(peer)!.dcReliable?.readyState).toBe('open');
    }
  });

  it('replaces the previous mode when start() is called again on an active pair', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);

    await a.voice.start('B', { mode: 'talk' });
    expect(a.voice.getActiveLinks()[0].mode).toBe('talk');

    await a.voice.start('B', { mode: 'listen' });
    const links = a.voice.getActiveLinks();
    expect(links).toEqual([{ peerId: 'B', mode: 'listen', state: 'connected' }]);
    const tr = rtcOf(a, 'B').getTransceivers()[0];
    expect(tr.currentDirection).toBe('recvonly');
    expect(rtcOf(a, 'B').getTransceivers().length).toBe(1); // transceiver reused, no m-line growth
  });
});

describe('VoiceManager — stop / lifecycle', () => {
  beforeEach(() => { installFakeRTC(); });

  it('SA3: stop() tears down the link, notifies the remote via SDP and releases the mic', async () => {
    const gum = installFakeGetUserMedia();
    const [a, b] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    // Simulate the remote stream having arrived on B
    const sA = new FakeMediaStream();
    rtcOf(b, 'A').ontrack?.({ track: sA.getAudioTracks()[0], streams: [sA] });

    const removedOnB: string[] = [];
    const statesOnB: string[] = [];
    b.voice.on('remoteStreamRemoved', (pid) => removedOnB.push(pid));
    b.voice.on('state', (_pid, s) => statesOnB.push(s));

    const micTrackA = gum.streams[0].getAudioTracks()[0];
    a.voice.stop('B');
    await flush();

    // Local: link gone, transceiver inactive, mic released (browser indicator off)
    expect(a.voice.getActiveLinks()).toEqual([]);
    expect(rtcOf(a, 'B').getTransceivers()[0].direction).toBe('inactive');
    expect(rtcOf(a, 'B').getTransceivers()[0].sender.track).toBeNull();
    expect(micTrackA.readyState).toBe('ended');

    // Remote: notified through renegotiation, no app call needed
    expect(removedOnB).toEqual(['A']);
    expect(statesOnB).toContain('disconnected');
    expect(b.voice.getActiveLinks()).toEqual([]);

    // DataChannels intact (initiator side, where fakes create them); B's peer untouched
    expect(a.pm.getPeer('B')!.dcReliable?.readyState).toBe('open');
    expect(b.pm.getPeer('A')).toBeDefined();
  });

  it('stopAll() tears down every active link', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B', 'C']);
    await a.voice.start('B', { mode: 'talk' });
    await a.voice.start('C', { mode: 'listen' });
    expect(a.voice.getActiveLinks().length).toBe(2);

    a.voice.stopAll();
    expect(a.voice.getActiveLinks()).toEqual([]);
  });

  it('reuses the inactive transceiver on a later start (no m-line growth)', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    a.voice.stop('B');
    await flush();

    await a.voice.start('B', { mode: 'talk' });
    expect(rtcOf(a, 'B').getTransceivers().length).toBe(1);
    expect(a.voice.getActiveLinks()).toEqual([{ peerId: 'B', mode: 'talk', state: 'connected' }]);
  });

  it('SA4: peer disconnect cleans up the voice link without renegotiating', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    const states: string[] = [];
    a.voice.on('state', (_pid, s) => states.push(s));

    // B leaves the room
    a.sig.__triggerRoster(['A']);
    await flush();

    expect(states).toContain('disconnected');
    expect(a.voice.getActiveLinks()).toEqual([]);
  });

  it('setMuted toggles outgoing audio without renegotiating', async () => {
    const gum = installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    const track = gum.streams[0].getAudioTracks()[0];
    expect(track.enabled).toBe(true);

    const announceBefore = rtcOf(a, 'B').signalingState;
    a.voice.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(a.voice.isMuted()).toBe(true);
    expect(rtcOf(a, 'B').signalingState).toBe(announceBefore); // no renegotiation

    a.voice.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it('a track acquired while muted starts disabled', async () => {
    const gum = installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    a.voice.setMuted(true);
    await a.voice.start('B', { mode: 'talk' });
    expect(gum.streams[0].getAudioTracks()[0].enabled).toBe(false);
  });

  it('dispose() rejects pending starts, releases the mic and clears listeners', async () => {
    const gum = installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    const micTrack = gum.streams[0].getAudioTracks()[0];

    a.voice.dispose();
    expect(a.voice.getActiveLinks()).toEqual([]);
    expect(micTrack.readyState).toBe('ended');
    await expect(a.voice.start('B', { mode: 'talk' })).rejects.toThrow(/disposed/);
  });
});

describe('VoiceManager — edge cases', () => {
  beforeEach(() => { installFakeRTC(); });

  it('stop() without an active link is a no-op, dispose() is idempotent', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    expect(() => a.voice.stop('B')).not.toThrow();
    expect(() => a.voice.stop('Z')).not.toThrow();
    a.voice.dispose();
    expect(() => a.voice.dispose()).not.toThrow();
  });

  it('start() fails cleanly when the renegotiation offer cannot be created', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const errors: Error[] = [];
    const states: string[] = [];
    a.voice.on('error', (_pid, e) => errors.push(e));
    a.voice.on('state', (_pid, s) => states.push(s));
    rtcOf(a, 'B').createOffer = async () => { throw new Error('offer boom'); };

    await expect(a.voice.start('B', { mode: 'talk' })).rejects.toThrow('offer boom');
    expect(errors.length).toBe(1);
    expect(states).toContain('failed');
  });

  it('answers recvonly to a remote sendonly offer (receive-only side)', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    a.sig.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly' }, 'B');
    await flush();

    const tr = rtcOf(a, 'B').getTransceivers()[0];
    expect(tr.direction).toBe('recvonly');
    expect(tr.sender.track).toBeNull();
    // Link adopted as listen
    expect(a.voice.getActiveLinks()).toEqual([{ peerId: 'B', mode: 'listen', state: 'connected' }]);
  });

  it('handles a remote stop offer (inactive) when no local link exists', async () => {
    installFakeGetUserMedia();
    const [a, b] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    b.voice.stop('A');
    await flush();
    // Both sides cleaned up
    expect(a.voice.getActiveLinks()).toEqual([]);
    expect(b.voice.getActiveLinks()).toEqual([]);
  });

  it('ignores renegotiation offers without an audio m-line (not a voice negotiation)', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    a.sig.__triggerDesc({ type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel' }, 'B');
    await flush();
    expect(a.voice.getActiveLinks()).toEqual([]);
    expect(rtcOf(a, 'B').getTransceivers().length).toBe(0);
  });

  it('a throwing event listener does not break other listeners', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const seen: string[] = [];
    a.voice.on('state', () => { throw new Error('listener boom'); });
    a.voice.on('state', (_pid, s) => seen.push(s));
    await a.voice.start('B', { mode: 'talk' });
    expect(seen).toContain('connected');
  });

  it('unsubscribe returned by on() removes the listener', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const seen: string[] = [];
    const off = a.voice.on('state', (_pid, s) => seen.push(s));
    off();
    await a.voice.start('B', { mode: 'talk' });
    expect(seen).toEqual([]);
  });

  it('ignores ontrack without streams when MediaStream is unavailable', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    await a.voice.start('B', { mode: 'talk' });
    const streams: unknown[] = [];
    a.voice.on('remoteStream', (_pid, s) => streams.push(s));
    rtcOf(a, 'B').ontrack?.({ track: new FakeMediaStreamTrack('audio') }); // no streams, no global MediaStream
    expect(streams).toEqual([]);
  });

  it('peerLeave without a voice link only clears cached remote streams', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const remote = new FakeMediaStream();
    rtcOf(a, 'B').ontrack?.({ track: remote.getAudioTracks()[0], streams: [remote] });
    a.sig.__triggerRoster(['A']);
    await flush();
    expect(a.voice.getActiveLinks()).toEqual([]);
  });

  it('rejects a localStream without audio track', async () => {
    installFakeGetUserMedia();
    const [a] = await setupRoom(['A', 'B']);
    const noAudio = new FakeMediaStream([]);
    await expect(a.voice.start('B', { mode: 'talk', localStream: noAudio as unknown as MediaStream }))
      .rejects.toThrow(/no audio track/);
  });

  it('rejects talk when getUserMedia is unavailable in the environment', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    const [a] = await setupRoom(['A', 'B']);
    await expect(a.voice.start('B', { mode: 'talk' })).rejects.toThrow(/not available/);
  });
});
