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

export interface FakeRTCOptions {
  initialConnectionState?: RTCPeerConnectionState;
  connectOnSetLocalDescription?: boolean;
}

export class FakeRTCPeerConnection {
  onicecandidate: ((ev: { candidate?: { toJSON(): unknown } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  connectionState: RTCPeerConnectionState;
  signalingState: RTCSignalingState = 'stable';
  private _channels = new Map<string, FakeDataChannel>();
  private connectOnSetLocal: boolean;

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

  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: '' }; }

  async setLocalDescription(_: RTCSessionDescriptionInit): Promise<void> {
    if (this.connectOnSetLocal) {
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
    } else {
      this.signalingState = 'have-local-offer';
    }
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.type === 'answer') this.signalingState = 'stable';
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: '' }; }
  async addIceCandidate(_: RTCIceCandidateInit): Promise<void> {}
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

export function installFakeRTC(opts?: FakeRTCOptions) {
  (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {
    setInterval: globalThis.setInterval?.bind(globalThis),
    clearInterval: globalThis.clearInterval?.bind(globalThis),
  };
  (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakeRTCPeerConnection {
    constructor() { super(opts); }
  };
}
