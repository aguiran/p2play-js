import { EventBus } from "../events/EventBus";
import { BackpressureOptions, BackpressureStrategy, DebugOptions, NetMessage, PlayerId, SendDebugInfo, SerializationStrategy } from "../types";
import { createSerializer, Serializer } from "./serialization";

export interface SignalingAdapter {
  // Minimal adapter interface to exchange SDP and ICE via any channel (WS, REST, etc.)
  localId: PlayerId;
  roomId?: string;
  register(): Promise<void>;
  announce(localDescription: RTCSessionDescriptionInit, to?: PlayerId): Promise<void>;
  onRemoteDescription(cb: (desc: RTCSessionDescriptionInit, from: PlayerId) => void): void;
  onIceCandidate(cb: (candidate: RTCIceCandidateInit, from: PlayerId) => void): void;
  onRoster(cb: (roster: PlayerId[]) => void): void;
  sendIceCandidate(candidate: RTCIceCandidateInit, to?: PlayerId): Promise<void>;
}

export interface PeerInfo {
  id: PlayerId;
  rtc: RTCPeerConnection;
  dc?: RTCDataChannel;
  pingMs: number;
  lastPongTs?: number;
  outbox?: Array<string | ArrayBuffer>;
}

export class PeerManager {
  private peers: Map<PlayerId, PeerInfo> = new Map();
  private bus: EventBus;
  private signaling: SignalingAdapter;
  private pingIntervalId?: number;
  private localId: PlayerId;
  private pendingInitiators: Map<PlayerId, PeerInfo> = new Map();
  private bufferedRemoteIce: Map<PlayerId, RTCIceCandidateInit[]> = new Map();
  private hostId?: PlayerId;
  private serializer: Serializer;
  private customIceServers?: RTCIceServer[];
  private debug: DebugOptions = {};
  private serializationStrategy: SerializationStrategy = "json";
  private backpressure: Required<BackpressureOptions> = { strategy: "coalesce-moves", thresholdBytes: 262144 } as any;

constructor(bus: EventBus, signaling: SignalingAdapter, serializationStrategy: SerializationStrategy = "json", iceServers?: RTCIceServer[], debug?: DebugOptions, backpressure?: BackpressureOptions) {
    this.bus = bus;
    this.signaling = signaling;
    this.localId = signaling.localId;
    this.serializer = createSerializer(serializationStrategy);
  if (iceServers) this.customIceServers = iceServers;
  this.debug = debug ?? {};
  this.serializationStrategy = serializationStrategy;
  if (backpressure) this.backpressure = { strategy: backpressure.strategy ?? "coalesce-moves", thresholdBytes: backpressure.thresholdBytes ?? 262144 };
  }

  getPeerIds(): PlayerId[] {
    return Array.from(this.peers.keys());
  }

  getPeer(id: PlayerId): PeerInfo | undefined {
    return this.peers.get(id);
  }

  async createOrJoin(): Promise<void> {
    // Register presence and subscribe to roster updates for deterministic full-mesh
    await this.signaling.register();

    this.signaling.onRoster((roster) => {
      const rosterSet = new Set(roster);
      // Remove peers no longer in roster
      for (const [pid, info] of [...this.peers.entries()]) {
        if (!rosterSet.has(pid)) {
          try { info.rtc.close(); } catch {}
          this.peers.delete(pid);
          this.bus.emit("peerLeave", pid);
        }
      }
      // Initiate or re-initiate towards peers present in roster but missing or inactive
      for (const pid of roster) {
        if (pid === this.localId) continue;
        const existing = this.peers.get(pid);
        const isActive = !!(existing && existing.dc && existing.dc.readyState === "open" && existing.rtc.connectionState === "connected");
        if (isActive) continue;
        // Deterministic initiation: only smaller id initiates towards bigger id
        if (this.localId < pid) {
          this.createOfferTo(pid).catch(() => {});
        }
      }
    });
    this.signaling.onRemoteDescription(async (desc, from) => {
      if (from === this.localId) return; // ignore own
      let info = this.peers.get(from);
      if (desc.type === "answer") {
        const pending = this.pendingInitiators.get(from);
        if (!info && pending) {
          info = pending;
          this.pendingInitiators.delete(from);
          this.peers.set(from, info);
          this.flushBufferedIce(from, info);
          this.maybeElectHost(from);
        }
        if (!info) return; // stray answer
        if (info.rtc.signalingState !== "have-local-offer") return;
        await info.rtc.setRemoteDescription(desc);
        this.flushBufferedIce(from, info);
      } else if (desc.type === "offer") {
        if (info?.rtc.connectionState === "connected" || info?.rtc.connectionState === "connecting") return;
        if (!info) {
          info = await this.createPeer(from, false);
          this.flushBufferedIce(from, info);
          this.maybeElectHost(from);
        }
        if (info.rtc.signalingState !== "stable") return;
        await info.rtc.setRemoteDescription(desc);
        this.flushBufferedIce(from, info);
        const answer = await info.rtc.createAnswer();
        await info.rtc.setLocalDescription(answer);
        await this.signaling.announce(answer, from);
      }
    });

    this.signaling.onIceCandidate(async (candidate, from) => {
      if (from === this.localId) return; // ignore own
      const info = this.peers.get(from);
      if (info) {
        if (!info.rtc.remoteDescription) {
          // buffer until we have remote description
          const list = this.bufferedRemoteIce.get(from) ?? [];
          list.push(candidate);
          this.bufferedRemoteIce.set(from, list);
        } else {
          await info.rtc.addIceCandidate(candidate);
        }
      } else {
        // buffer until peer is known
        const list = this.bufferedRemoteIce.get(from) ?? [];
        list.push(candidate);
        this.bufferedRemoteIce.set(from, list);
      }
    });

    // No global offer; per-target offers will be created based on roster

    this.startPingLoop();
  }

  private async createPeer(id: PlayerId, isInitiator: boolean): Promise<PeerInfo> {
    const rtc = this.createRTCPeerConnection();
    const info: PeerInfo = { id, rtc, pingMs: 0 };
    this.wirePeer(info, isInitiator);
    return info;
  }

  private wirePeer(info: PeerInfo, isInitiator: boolean) {
    const { rtc } = info;
    rtc.onicecandidate = (ev) => {
      if (ev.candidate) this.signaling.sendIceCandidate(ev.candidate.toJSON(), info.id);
    };
    rtc.onconnectionstatechange = () => {
      if (rtc.connectionState === "connected") {
        // avoid adding self
        if (info.id !== this.localId) {
          // Add peer, elect host, then emit peerJoin to guarantee order hostChange -> peerJoin
          this.peers.set(info.id, info);
          this.electHost();
          this.bus.emit("peerJoin", info.id);
          // No global offer anymore
        }
      } else if (rtc.connectionState === "disconnected" || rtc.connectionState === "failed" || rtc.connectionState === "closed") {
        const existed = this.peers.delete(info.id);
        if (existed) this.bus.emit("peerLeave", info.id);
        // host migration: if we lost host, re-elect
        if (this.hostId === info.id) {
          this.hostId = undefined;
          this.electHost();
        }
      }
    };

    if (isInitiator && info.dc) {
      this.setupDataChannel(info, info.dc);
    } else {
      rtc.ondatachannel = (ev) => {
        this.setupDataChannel(info, ev.channel);
      };
    }
  }

  private setupDataChannel(info: PeerInfo, dc: RTCDataChannel) {
    info.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => this.onMessage(info.id, ev.data);
    dc.onopen = () => {
      // flush queued messages
      if (info.outbox && info.outbox.length) {
        for (const payload of info.outbox) {
          try {
            if (typeof payload === "string") dc.send(payload);
            else dc.send(payload);
          } catch {}
        }
        info.outbox = [];
      }
    };
  }

  private createRTCPeerConnection(): RTCPeerConnection {
    const iceServers = this.customIceServers ?? [{ urls: ["stun:stun.l.google.com:19302"] }];
    return new RTCPeerConnection({ iceServers });
  }

  

  private async createOfferTo(targetId: PlayerId): Promise<void> {
    if (this.pendingInitiators.has(targetId) || this.peers.has(targetId)) return;
    const rtc = this.createRTCPeerConnection();
    const dc = rtc.createDataChannel("game", { ordered: false, maxRetransmits: 0 });
    const info: PeerInfo = { id: targetId, rtc, dc, pingMs: 0 };
    this.pendingInitiators.set(targetId, info);
    this.wirePeer(info, true);
    const offer = await rtc.createOffer();
    await rtc.setLocalDescription(offer);
    await this.signaling.announce(offer, targetId);
  }

  private flushBufferedIce(peerId: PlayerId, info: PeerInfo) {
    const list = this.bufferedRemoteIce.get(peerId);
    if (!list) return;
    list.forEach((c) => info.rtc.addIceCandidate(c));
    this.bufferedRemoteIce.delete(peerId);
  }

  private maybeElectHost(newPeerId: PlayerId) {
    // Always re-evaluate to ensure smallest-id host after any topology change
    this.electHost();
  }

  private electHost() {
    // Simple deterministic election: smallest id among local + peers
    const all = [this.localId, ...this.getPeerIds()].sort();
    const newHost = all[0];
    if (newHost !== this.hostId) {
      this.hostId = newHost;
      this.bus.emit("hostChange", newHost);
    }
  }

  getHostId(): PlayerId | undefined {
    return this.hostId;
  }

  private onMessage(from: PlayerId, data: string | ArrayBuffer) {
    if (typeof data === "string") {
      const raw = data;
      const msg: any = JSON.parse(data);
      if ((msg as any).t === "ping") {
        const pong = JSON.stringify({ t: "pong", ts: (msg as any).ts });
        this.getPeer(from)?.dc?.send(pong);
        return;
      }
      if ((msg as any).t === "pong") {
        const now = performance.now();
        const rtt = now - (msg as any).ts;
        const peer = this.getPeer(from);
        if (peer) {
          peer.pingMs = rtt;
          peer.lastPongTs = now;
          this.bus.emit("ping", from, rtt);
        }
        return;
      }
      this.bus.emit("netMessage", msg as NetMessage);
    } else {
      // binary path via serializer
      try {
        const msg = this.serializer.decode(data as ArrayBuffer) as NetMessage;
        this.bus.emit("netMessage", msg);
      } catch {
        // ignore invalid frames
      }
    }
  }

  broadcast(message: NetMessage): void {
    const payload = this.serializer.encode(message);
    let delivered = 0;
    let queued = 0;
    for (const peer of this.peers.values()) {
      if (this.trySend(peer.dc, payload)) {
        delivered++;
      } else {
        if (!peer.outbox) peer.outbox = [];
        this.pushOutbox(peer, payload, message);
        queued++;
      }
    }
    this.maybeDebug({ type: "broadcast", to: "all", payloadBytes: this.sizeOf(payload), delivered, queued, serialization: this.serializationStrategy, timestamp: performance.now() });
  }

  send(to: PlayerId, message: NetMessage): void {
    const peer = this.peers.get(to);
    const payload = this.serializer.encode(message);
    let delivered = 0, queued = 0;
    if (peer && this.trySend(peer.dc, payload)) {
      delivered = 1;
    } else if (peer) {
      if (!peer.outbox) peer.outbox = [];
      this.pushOutbox(peer, payload, message);
      queued = 1;
    }
    this.maybeDebug({ type: "send", to, payloadBytes: this.sizeOf(payload), delivered, queued, serialization: this.serializationStrategy, timestamp: performance.now() });
  }

  private trySend(dc: RTCDataChannel | undefined, payload: string | ArrayBuffer): boolean {
    if (!dc || dc.readyState !== "open") return false;
    if (this.backpressure.strategy !== "off" && dc.bufferedAmount > this.backpressure.thresholdBytes) return false;
    if (typeof payload === "string") {
      dc.send(payload);
    } else {
      dc.send(payload);
    }
    return true;
  }

  private pushOutbox(peer: PeerInfo, payload: string | ArrayBuffer, message: NetMessage) {
    if (this.backpressure.strategy === "coalesce-moves" && message.t === "move") {
        // Replace the older queued position with the most recent one
      const box = peer.outbox as (string | ArrayBuffer)[];
      for (let i = box.length - 1; i >= 0; i--) {
        const prev = box[i];
        // Heuristic: if it's also a serialized move, replace it
        try {
          const txt = typeof prev === 'string' ? prev : new TextDecoder().decode(prev as ArrayBuffer);
          const parsed = JSON.parse(txt);
          if (parsed && parsed.t === 'move') { box[i] = payload; return; }
        } catch {}
      }
    }
    if (this.backpressure.strategy === "drop-moves" && message.t === "move") {
      const buffered = peer.dc?.bufferedAmount ?? 0;
       if (buffered > this.backpressure.thresholdBytes) return; // drop move when channel is saturated
    }
    peer.outbox!.push(payload);
  }

  private sizeOf(payload: string | ArrayBuffer): number {
    if (typeof payload === "string") return new TextEncoder().encode(payload).length;
    return (payload as ArrayBuffer).byteLength;
  }

  private maybeDebug(info: SendDebugInfo) {
    if (!this.debug.enabled) return;
    try { this.debug.onSend?.(info); } catch {}
  }

  private startPingLoop() {
    if (this.pingIntervalId) window.clearInterval(this.pingIntervalId);
    this.pingIntervalId = window.setInterval(() => {
      const ts = performance.now();
      const ping = JSON.stringify({ t: "ping", ts });
      for (const peer of this.peers.values()) {
        if (peer.dc?.readyState === "open") peer.dc.send(ping);
      }
    }, 2000);
  }
}

