import { EventBus } from "../events/EventBus";
import { BackpressureOptions, BackpressureStrategy, DebugOptions, NetMessage, PlayerId, SendDebugInfo, SendOptions, SerializationStrategy } from "../types";
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
  close?(): void;
}

export interface PeerInfo {
  id: PlayerId;
  rtc: RTCPeerConnection;
  dcUnreliable?: RTCDataChannel;
  dcReliable?: RTCDataChannel;
  pingMs: number;
  lastPongTs?: number;
  outboxUnreliable?: Array<string | ArrayBuffer>;
  outboxReliable?: Array<string | ArrayBuffer>;
}

const PENDING_OFFER_TIMEOUT_MS = 30_000;
const UNRELIABLE_TYPES: ReadonlySet<string> = new Set(["move", "ping", "pong"]);

export class PeerManager {
  private peers: Map<PlayerId, PeerInfo> = new Map();
  private bus: EventBus;
  private signaling: SignalingAdapter;
  private pingIntervalId?: number;
  private localId: PlayerId;
  private pendingInitiators: Map<PlayerId, PeerInfo> = new Map();
  private pendingTimeouts: Map<PlayerId, ReturnType<typeof setTimeout>> = new Map();
  private bufferedRemoteIce: Map<PlayerId, RTCIceCandidateInit[]> = new Map();
  private hostId?: PlayerId;
  private serializer: Serializer;
  private customIceServers?: RTCIceServer[];
  private debug: DebugOptions = {};
  private serializationStrategy: SerializationStrategy = "json";
  private backpressure: Required<BackpressureOptions> = { strategy: "coalesce-moves", thresholdBytes: 262144 };
  private maxPlayers?: number;
  private disposed = false;

constructor(bus: EventBus, signaling: SignalingAdapter, serializationStrategy: SerializationStrategy = "json", iceServers?: RTCIceServer[], debug?: DebugOptions, backpressure?: BackpressureOptions, maxPlayers?: number) {
    this.bus = bus;
    this.signaling = signaling;
    this.localId = signaling.localId;
    this.serializer = createSerializer(serializationStrategy);
  if (iceServers) this.customIceServers = iceServers;
  this.debug = debug ?? {};
  this.serializationStrategy = serializationStrategy;
  if (backpressure) this.backpressure = { strategy: backpressure.strategy ?? "coalesce-moves", thresholdBytes: backpressure.thresholdBytes ?? 262144 };
  this.maxPlayers = maxPlayers;
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
      if (this.disposed) return;
      const rosterSet = new Set(roster);
      // Remove peers no longer in roster
      for (const [pid, info] of [...this.peers.entries()]) {
        if (!rosterSet.has(pid)) {
          try { info.rtc.close(); } catch {}
          this.peers.delete(pid);
          this.bus.emit("peerLeave", pid);
        }
      }
      // Cleanup pendingInitiators no longer in roster
      for (const [targetId, info] of [...this.pendingInitiators.entries()]) {
        if (!rosterSet.has(targetId)) {
          const t = this.pendingTimeouts.get(targetId);
          if (t !== undefined) { clearTimeout(t); this.pendingTimeouts.delete(targetId); }
          try { info.rtc.close(); } catch {}
          this.pendingInitiators.delete(targetId);
        }
      }
      // Initiate or re-initiate towards peers present in roster but missing or inactive
      for (const pid of roster) {
        if (pid === this.localId) continue;
        const existing = this.peers.get(pid);
        const isActive = !!(existing && existing.rtc.connectionState === "connected");
        if (isActive) continue;
        // Capacity check: do not initiate beyond max remote peers allowed
        if (this.getInUseRemoteSlots() >= this.getMaxRemotePeers()) {
          if (this.maxPlayers) this.bus.emit("maxCapacityReached", this.maxPlayers);
          continue;
        }
        // Deterministic initiation: only smaller id (same order as host election) initiates towards bigger id
        if (this.comparePlayerIds(this.localId, pid) < 0) {
          this.createOfferTo(pid).catch(() => {});
        }
      }
    });
    this.signaling.onRemoteDescription(async (desc, from) => {
      if (this.disposed) return;
      if (from === this.localId) return; // ignore own
      let info = this.peers.get(from);
      if (desc.type === "answer") {
        const pending = this.pendingInitiators.get(from);
        if (!info && pending) {
          info = pending;
          const t = this.pendingTimeouts.get(from);
          if (t !== undefined) { clearTimeout(t); this.pendingTimeouts.delete(from); }
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
        // Capacity check: ignore offers if at capacity
        if (this.getInUseRemoteSlots() >= this.getMaxRemotePeers()) {
          if (this.maxPlayers) this.bus.emit("maxCapacityReached", this.maxPlayers);
          return;
        }
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
      if (this.disposed) return;
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
      if (this.disposed) return;
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
        const wasPending = this.pendingInitiators.get(info.id) === info;
        if (wasPending) {
          const t = this.pendingTimeouts.get(info.id);
          if (t !== undefined) { clearTimeout(t); this.pendingTimeouts.delete(info.id); }
          this.pendingInitiators.delete(info.id);
        }
        const existed = this.peers.delete(info.id);
        if (existed) this.bus.emit("peerLeave", info.id);
        // host migration: if we lost host, re-elect
        if (this.hostId === info.id) {
          this.hostId = undefined;
          this.electHost();
        }
      }
    };

    if (isInitiator) {
      if (info.dcUnreliable) this.setupDataChannel(info, info.dcUnreliable, "unreliable");
      if (info.dcReliable) this.setupDataChannel(info, info.dcReliable, "reliable");
    } else {
      rtc.ondatachannel = (ev) => {
        const label = ev.channel.label;
        if (label === "game-unreliable") {
          this.setupDataChannel(info, ev.channel, "unreliable");
        } else if (label === "game-reliable") {
          this.setupDataChannel(info, ev.channel, "reliable");
        }
      };
    }
  }

  private setupDataChannel(info: PeerInfo, dc: RTCDataChannel, kind: "unreliable" | "reliable") {
    if (kind === "unreliable") {
      info.dcUnreliable = dc;
    } else {
      info.dcReliable = dc;
    }
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => this.onMessage(info.id, ev.data);
    dc.onopen = () => {
      const outbox = kind === "unreliable" ? info.outboxUnreliable : info.outboxReliable;
      if (outbox && outbox.length) {
        for (const payload of outbox) {
          try {
            if (typeof payload === "string") dc.send(payload);
            else dc.send(payload);
          } catch (error) {
            console.warn(`Failed to send queued message to peer ${info.id} (${kind}):`, error);
          }
        }
        if (kind === "unreliable") info.outboxUnreliable = [];
        else info.outboxReliable = [];
      }
    };
  }

  private createRTCPeerConnection(): RTCPeerConnection {
    const iceServers = this.customIceServers ?? [{ urls: ["stun:stun.l.google.com:19302"] }];
    return new RTCPeerConnection({ iceServers });
  }

  

  private async createOfferTo(targetId: PlayerId): Promise<void> {
    if (this.disposed) return;
    if (this.pendingInitiators.has(targetId) || this.peers.has(targetId)) return;
    const rtc = this.createRTCPeerConnection();
    const dcUnreliable = rtc.createDataChannel("game-unreliable", { ordered: false, maxRetransmits: 0 });
    const dcReliable = rtc.createDataChannel("game-reliable", { ordered: true });
    const info: PeerInfo = { id: targetId, rtc, dcUnreliable, dcReliable, pingMs: 0 };
    this.pendingInitiators.set(targetId, info);
    const timeoutId = setTimeout(() => {
      if (this.disposed) return;
      if (this.pendingInitiators.get(targetId) === info) {
        this.pendingTimeouts.delete(targetId);
        this.pendingInitiators.delete(targetId);
        try { info.rtc.close(); } catch {}
        if (this.debug.enabled) console.debug("[p2play] pending offer timeout:", targetId);
      }
    }, PENDING_OFFER_TIMEOUT_MS);
    this.pendingTimeouts.set(targetId, timeoutId);
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

  /**
   * Deterministic total order for host election: numeric when both IDs are digit-only,
   * else strict binary string order (no locale).
   */
  private comparePlayerIds(a: PlayerId, b: PlayerId): number {
    const digitOnly = /^\d+$/;
    if (digitOnly.test(a) && digitOnly.test(b)) {
      const na = BigInt(a);
      const nb = BigInt(b);
      if (na !== nb) return na < nb ? -1 : 1;
      // Tie-break: same numeric value, different string (e.g. "2" vs "02")
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private electHost() {
    const all = [this.localId, ...this.getPeerIds()];
    const newHost = all.reduce((min, id) => (this.comparePlayerIds(id, min) < 0 ? id : min));
    if (newHost !== this.hostId) {
      this.hostId = newHost;
      this.bus.emit("hostChange", newHost);
    }
  }

  getHostId(): PlayerId | undefined {
    return this.hostId;
  }

  private onMessage(from: PlayerId, data: string | ArrayBuffer) {
    if (this.disposed) return;
    if (typeof data === "string") {
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        if (this.debug.enabled) console.debug("[p2play] parse dropped: invalid JSON");
        return;
      }
      if (!msg || typeof msg !== "object") {
        if (this.debug.enabled) console.debug("[p2play] parse dropped: not an object");
        return;
      }
      const m = msg as Record<string, unknown>;
      if (m.t === "ping" && typeof m.ts === "number") {
        this.getPeer(from)?.dcUnreliable?.send(JSON.stringify({ t: "pong", ts: m.ts }));
        return;
      }
      if (m.t === "pong" && typeof m.ts === "number") {
        const now = performance.now();
        const rtt = now - m.ts;
        const peer = this.getPeer(from);
        if (peer) {
          peer.pingMs = rtt;
          peer.lastPongTs = now;
          this.bus.emit("ping", from, rtt);
        }
        return;
      }
      (m as unknown as NetMessage).from = from; // transport identity overrides payload (anti-spoofing)
      this.bus.emit("netMessage", m as unknown as NetMessage);
    } else {
      // binary path via serializer
      try {
        const msg = this.serializer.decode(data as ArrayBuffer) as NetMessage;
        (msg as NetMessage).from = from; // transport identity overrides payload (anti-spoofing)
        this.bus.emit("netMessage", msg);
      } catch {
        if (this.debug.enabled) console.debug("[p2play] parse dropped: invalid binary frame");
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pingIntervalId !== undefined) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = undefined;
    }
    for (const t of this.pendingTimeouts.values()) clearTimeout(t);
    this.pendingTimeouts.clear();
    for (const info of this.peers.values()) {
      try { info.rtc.close(); } catch {}
    }
    this.peers.clear();
    for (const info of this.pendingInitiators.values()) {
      try { info.rtc.close(); } catch {}
    }
    this.pendingInitiators.clear();
    this.bufferedRemoteIce.clear();
    this.hostId = undefined;
  }

  private pickChannel(msg: NetMessage, options?: SendOptions): "unreliable" | "reliable" {
    if (options?.unreliable === true) return "unreliable";
    return UNRELIABLE_TYPES.has(msg.t) ? "unreliable" : "reliable";
  }

  broadcast(message: NetMessage, options?: SendOptions): void {
    const payload = this.serializer.encode(message);
    const kind = this.pickChannel(message, options);
    let delivered = 0;
    let queued = 0;
    for (const peer of this.peers.values()) {
      const dc = kind === "unreliable" ? peer.dcUnreliable : peer.dcReliable;
      if (this.trySend(dc, payload, kind === "unreliable")) {
        delivered++;
      } else {
        const outboxKey = kind === "unreliable" ? "outboxUnreliable" : "outboxReliable";
        if (!peer[outboxKey]) peer[outboxKey] = [];
        this.pushOutbox(peer, payload, message, kind);
        queued++;
      }
    }
    this.maybeDebug({ type: "broadcast", to: "all", payloadBytes: this.sizeOf(payload), delivered, queued, serialization: this.serializationStrategy, timestamp: performance.now() });
  }

  send(to: PlayerId, message: NetMessage, options?: SendOptions): void {
    const peer = this.peers.get(to);
    const payload = this.serializer.encode(message);
    const kind = this.pickChannel(message, options);
    let delivered = 0, queued = 0;
    const dc = peer ? (kind === "unreliable" ? peer.dcUnreliable : peer.dcReliable) : undefined;
    if (peer && this.trySend(dc, payload, kind === "unreliable")) {
      delivered = 1;
    } else if (peer) {
      const outboxKey = kind === "unreliable" ? "outboxUnreliable" : "outboxReliable";
      if (!peer[outboxKey]) peer[outboxKey] = [];
      this.pushOutbox(peer, payload, message, kind);
      queued = 1;
    }
    this.maybeDebug({ type: "send", to, payloadBytes: this.sizeOf(payload), delivered, queued, serialization: this.serializationStrategy, timestamp: performance.now() });
  }

  private trySend(dc: RTCDataChannel | undefined, payload: string | ArrayBuffer, applyBackpressure: boolean): boolean {
    if (!dc || dc.readyState !== "open") return false;
    if (applyBackpressure && this.backpressure.strategy !== "off" && dc.bufferedAmount > this.backpressure.thresholdBytes) return false;
    if (typeof payload === "string") {
      dc.send(payload);
    } else {
      dc.send(payload);
    }
    return true;
  }

  private pushOutbox(peer: PeerInfo, payload: string | ArrayBuffer, message: NetMessage, kind: "unreliable" | "reliable") {
    const outbox = kind === "unreliable" ? peer.outboxUnreliable : peer.outboxReliable;
    if (this.backpressure.strategy === "coalesce-moves" && message.t === "move") {
      const box = outbox as (string | ArrayBuffer)[];
      for (let i = box.length - 1; i >= 0; i--) {
        const prev = box[i];
        try {
          const txt = typeof prev === 'string' ? prev : new TextDecoder().decode(prev as ArrayBuffer);
          const parsed = JSON.parse(txt);
          if (parsed && parsed.t === 'move') { box[i] = payload; return; }
        } catch (error) {
          console.debug(`Invalid message in outbox, skipping coalesce:`, error);
        }
      }
    }
    if (this.backpressure.strategy === "drop-moves" && message.t === "move") {
      const buffered = peer.dcUnreliable?.bufferedAmount ?? 0;
      if (buffered > this.backpressure.thresholdBytes) return;
    }
    outbox!.push(payload);
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
        if (peer.dcUnreliable?.readyState === "open") peer.dcUnreliable.send(ping);
      }
    }, 2000);
  }

  private getMaxRemotePeers(): number {
    if (!this.maxPlayers) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.maxPlayers - 1);
  }

  private getInUseRemoteSlots(): number {
    // Count connected peers plus pending initiators to avoid overshooting capacity
    return this.peers.size + this.pendingInitiators.size;
  }
}

