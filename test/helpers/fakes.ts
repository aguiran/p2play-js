export class FakeDataChannel {
  label: string;
  readyState: 'open' | 'closed' | 'connecting' = 'open';
  bufferedAmount = 0;
  binaryType: string = 'arraybuffer';
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];

  constructor(label: string = 'game-unreliable') {
    this.label = label;
  }

  send(p: string | ArrayBuffer) { this.sent.push(p); }
}

export class FakeMediaStreamTrack {
  kind: string;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  constructor(kind: string = 'audio') { this.kind = kind; }
  stop() { this.readyState = 'ended'; }
}

export class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[] = [new FakeMediaStreamTrack('audio')]) {
    this.tracks = tracks;
  }
  getTracks(): FakeMediaStreamTrack[] { return [...this.tracks]; }
  getAudioTracks(): FakeMediaStreamTrack[] { return this.tracks.filter((t) => t.kind === 'audio'); }
}

export class FakeTransceiver {
  direction: string;
  currentDirection: string | null = null;
  sender: { track: FakeMediaStreamTrack | null; replaceTrack: (t: FakeMediaStreamTrack | null) => Promise<void> };
  receiver: { track: FakeMediaStreamTrack };

  constructor(direction: string = 'sendrecv') {
    this.direction = direction;
    this.sender = {
      track: null,
      replaceTrack: async (t: FakeMediaStreamTrack | null) => { this.sender.track = t; },
    };
    this.receiver = { track: new FakeMediaStreamTrack('audio') };
  }
}

export interface FakeRTCOptions {
  initialConnectionState?: RTCPeerConnectionState;
  connectOnSetLocalDescription?: boolean;
}

export class FakeRTCPeerConnection {
  onicecandidate: ((ev: { candidate?: { toJSON(): unknown } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  ontrack: ((ev: { track: FakeMediaStreamTrack; streams?: FakeMediaStream[]; transceiver?: FakeTransceiver }) => void) | null = null;
  connectionState: RTCPeerConnectionState;
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  addedIceCandidates: RTCIceCandidateInit[] = [];
  /** When set, negotiated currentDirection is forced to this value (simulates remote rejection) */
  negotiatedDirectionOverride: string | null = null;
  private _channels = new Map<string, FakeDataChannel>();
  private _transceivers: FakeTransceiver[] = [];
  private connectOnSetLocal: boolean;
  private announcedConnected = false;

  constructor(opts?: FakeRTCOptions) {
    this.connectionState = opts?.initialConnectionState ?? 'new';
    this.connectOnSetLocal = opts?.connectOnSetLocalDescription ?? true;
  }

  createDataChannel(label?: string, _opts?: unknown): FakeDataChannel {
    const dc = new FakeDataChannel(label ?? 'game-unreliable');
    this._channels.set(dc.label, dc);
    return dc;
  }

  getChannel(label: string): FakeDataChannel | undefined {
    return this._channels.get(label);
  }

  addTransceiver(_kind: string, init?: { direction?: string }): FakeTransceiver {
    const tr = new FakeTransceiver(init?.direction ?? 'sendrecv');
    this._transceivers.push(tr);
    return tr;
  }

  getTransceivers(): FakeTransceiver[] { return [...this._transceivers]; }

  private buildSdp(): string {
    let sdp = 'v=0';
    for (const tr of this._transceivers) {
      sdp += `\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${tr.direction}`;
    }
    return sdp;
  }

  private applyNegotiatedDirections(): void {
    for (const tr of this._transceivers) {
      tr.currentDirection = this.negotiatedDirectionOverride ?? tr.direction;
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: this.buildSdp() }; }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc?.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    // Initial negotiation: legacy behavior (announce connected once)
    if (this.connectOnSetLocal && !this.announcedConnected) {
      this.connectionState = 'connected';
      this.announcedConnected = true;
      if (desc.type === 'answer') {
        this.signalingState = 'stable';
        this.applyNegotiatedDirections();
      }
      this.onconnectionstatechange?.();
      return;
    }
    // Renegotiation on an established connection
    if (this.connectionState === 'connected') {
      if (desc.type === 'offer') {
        this.signalingState = 'have-local-offer';
      } else {
        this.signalingState = 'stable';
        this.applyNegotiatedDirections();
      }
      return;
    }
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
    if (desc.type === 'answer') {
      this.signalingState = 'stable';
      this.applyNegotiatedDirections();
    } else if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      // Like real WebRTC: applying a remote offer creates transceivers for new m-lines
      if (desc.sdp) {
        const audioCount = (desc.sdp.match(/m=audio/g) || []).length;
        while (this._transceivers.length < audioCount) {
          this._transceivers.push(new FakeTransceiver('recvonly'));
        }
      }
    }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: this.buildSdp() }; }
  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> { this.addedIceCandidates.push(c); }
  close() {}
}

export function createMockSignaling(localId: string) {
  let rosterCb: ((r: string[]) => void) | undefined;
  let descCb: ((d: RTCSessionDescriptionInit, from: string) => void) | undefined;
  let iceCb: ((candidate: RTCIceCandidateInit, from: string) => void) | undefined;
  return {
    localId,
    register: async () => {},
    announce: async (_: RTCSessionDescriptionInit, __?: string) => {},
    onRemoteDescription: (cb: (d: RTCSessionDescriptionInit, from: string) => void) => { descCb = cb; },
    onIceCandidate: (cb: (candidate: RTCIceCandidateInit, from: string) => void) => { iceCb = cb; },
    onRoster: (cb: (r: string[]) => void) => { rosterCb = cb; },
    sendIceCandidate: async (_: RTCIceCandidateInit, __?: string) => {},
    __triggerRoster: (list: string[]) => rosterCb?.(list),
    __triggerOffer: (from: string) => descCb?.({ type: 'offer', sdp: '' }, from),
    __triggerDesc: (desc: RTCSessionDescriptionInit, from: string) => descCb?.(desc, from),
    __triggerIce: (cand: RTCIceCandidateInit, from: string) => iceCb?.(cand, from),
    close: () => {},
  };
}

export function installFakeGetUserMedia(opts?: { deny?: boolean }) {
  const calls: unknown[] = [];
  const streams: FakeMediaStream[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async (constraints: unknown) => {
          calls.push(constraints);
          if (opts?.deny) throw new Error('Permission denied');
          const stream = new FakeMediaStream([new FakeMediaStreamTrack('audio')]);
          streams.push(stream);
          return stream;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  return { calls, streams };
}

/**
 * Wire mock signalings together so announce()/sendIceCandidate() are routed to
 * the other parties (targeted via `to`, broadcast otherwise). Deliveries are
 * deferred to a microtask to mimic asynchronous transport.
 */
export function linkMockSignalings(sigs: Array<ReturnType<typeof createMockSignaling>>) {
  for (const sig of sigs) {
    sig.announce = async (desc: RTCSessionDescriptionInit, to?: string) => {
      const payload = JSON.parse(JSON.stringify(desc));
      for (const other of sigs) {
        if (other.localId === sig.localId) continue;
        if (to && to !== other.localId) continue;
        queueMicrotask(() => other.__triggerDesc(payload, sig.localId));
      }
    };
    sig.sendIceCandidate = async (candidate: RTCIceCandidateInit, to?: string) => {
      for (const other of sigs) {
        if (other.localId === sig.localId) continue;
        if (to && to !== other.localId) continue;
        queueMicrotask(() => other.__triggerIce(candidate, sig.localId));
      }
    };
  }
}

export function installFakeRTC(opts?: FakeRTCOptions) {
  (globalThis as Record<string, unknown>).window = {
    setInterval: globalThis.setInterval?.bind(globalThis),
    clearInterval: globalThis.clearInterval?.bind(globalThis),
  };
  (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakeRTCPeerConnection {
    constructor() { super(opts); }
  };
}
