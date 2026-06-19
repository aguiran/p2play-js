import { EventBus } from "../events/EventBus";
import { PeerManager } from "../net/PeerManager";
import { PlayerId, VoiceEventHandlerMap, VoiceEventName, VoiceMode, VoiceOptions, VoiceState } from "../types";

interface VoiceLink {
  mode: VoiceMode;
  transceiver: RTCRtpTransceiver;
  remoteStream?: MediaStream;
  state: VoiceState;
  /** True when our shared/custom track is attached to this link's sender */
  sending: boolean;
  pendingStart?: { resolve: () => void; reject: (e: Error) => void };
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Selective peer-to-peer audio (`talk` / `listen`) over the RTCPeerConnections
 * already opened for DataChannels. Fully SDP-driven: the transceiver directions
 * carried by the renegotiation offer are the only signaling needed — the
 * existing `desc`/`ice` envelopes and `SignalingAdapter` are reused untouched.
 *
 * - `talk`: bidirectional (local sendrecv <-> remote sendrecv)
 * - `listen`: unidirectional (local recvonly <-> remote sendonly)
 *
 * The remote peer auto-handles incoming renegotiation: only the caller of
 * `start()` initiates. When an incoming offer requests local audio, the
 * library acquires the microphone (the browser permission prompt is the
 * consent gate); on denial the negotiation still completes without audio
 * and an `error` event is emitted.
 */
export class VoiceManager {
  private readonly peers: PeerManager;
  private readonly links: Map<PlayerId, VoiceLink> = new Map();
  private readonly listeners = new Map<VoiceEventName, Set<Function>>();
  /** Last remote stream per peer, kept outside links so answerer-side tracks arriving before link adoption are not lost */
  private readonly remoteStreams: Map<PlayerId, MediaStream> = new Map();
  /** Microphone stream acquired by the library (owned: tracks are stopped on release) */
  private sharedMicStream?: MediaStream;
  private muted = false;
  private disposed = false;

  constructor(peers: PeerManager, bus: EventBus) {
    this.peers = peers;
    this.peers.setMediaNegotiationHooks({
      onRemoteOfferApplied: (peerId, rtc) => this.handleRemoteOfferApplied(peerId, rtc),
      onNegotiationSettled: (peerId) => this.handleNegotiationSettled(peerId),
      onTrack: (peerId, ev) => this.handleTrack(peerId, ev),
    });
    bus.on("peerLeave", (peerId: PlayerId) => this.handlePeerGone(peerId));
  }

  on<N extends VoiceEventName>(event: N, fn: VoiceEventHandlerMap[N]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => { this.listeners.get(event)?.delete(fn); };
  }

  private emit<N extends VoiceEventName>(event: N, ...args: Parameters<VoiceEventHandlerMap[N]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((fn) => {
      try { (fn as (...a: Parameters<VoiceEventHandlerMap[N]>) => void)(...args); } catch {}
    });
  }

  /**
   * Open (or replace) a voice link towards a connected peer.
   * Resolves once the SDP renegotiation completes (signaling back to "stable"
   * with a compatible negotiated direction). `remoteStream` is emitted
   * separately when the remote track arrives.
   */
  async start(remotePeerId: PlayerId, options: VoiceOptions): Promise<void> {
    if (this.disposed) throw new Error("VoiceManager has been disposed");
    const peer = this.peers.getPeer(remotePeerId);
    if (!peer || peer.rtc.connectionState !== "connected") {
      throw new Error(`Cannot start voice: no connected peer "${remotePeerId}"`);
    }
    const { mode } = options;
    let track: MediaStreamTrack | null = null;
    if (mode === "talk") {
      try {
        track = await this.acquireTrack(options.localStream);
      } catch (e) {
        const err = toError(e);
        this.emit("error", remotePeerId, err);
        throw err;
      }
    }
    const direction: RTCRtpTransceiverDirection = mode === "talk" ? "sendrecv" : "recvonly";
    let link = this.links.get(remotePeerId);
    if (link) {
      // Replace previous mode (idempotent semantics)
      link.pendingStart?.reject(new Error("Voice start superseded by a newer start()"));
      link.pendingStart = undefined;
      link.mode = mode;
      link.transceiver.direction = direction;
      try { await link.transceiver.sender.replaceTrack(track); } catch {}
      link.sending = !!track;
    } else {
      const transceiver = this.findReusableAudioTransceiver(peer.rtc) ?? peer.rtc.addTransceiver("audio", { direction });
      transceiver.direction = direction;
      if (track) {
        try { await transceiver.sender.replaceTrack(track); } catch {}
      }
      link = { mode, transceiver, state: "connecting", sending: !!track };
      this.links.set(remotePeerId, link);
      this.emit("state", remotePeerId, "connecting");
    }
    this.setState(remotePeerId, link, "connecting");
    const negotiated = new Promise<void>((resolve, reject) => {
      link!.pendingStart = { resolve, reject };
    });
    try {
      await this.peers.renegotiate(remotePeerId);
    } catch (e) {
      link.pendingStart = undefined;
      const err = toError(e);
      this.setState(remotePeerId, link, "failed");
      this.emit("error", remotePeerId, err);
      throw err;
    }
    await negotiated;
  }

  /**
   * Tear down the voice link towards a peer. The transceiver is kept (reused on
   * the next `start`, avoiding m-line growth) but set to "inactive" with no
   * track; the remote detects the direction change through renegotiation.
   */
  stop(remotePeerId: PlayerId): void {
    const link = this.links.get(remotePeerId);
    if (!link) return;
    this.teardownLink(remotePeerId, link, { renegotiate: true });
  }

  stopAll(): void {
    for (const peerId of [...this.links.keys()]) this.stop(peerId);
  }

  /** Disable/enable all outgoing audio without renegotiating. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const link of this.links.values()) {
      const track = link.transceiver.sender.track;
      if (track) track.enabled = !muted;
    }
    if (this.sharedMicStream) {
      for (const t of this.sharedMicStream.getAudioTracks()) t.enabled = !muted;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Currently active voice links (peer id -> mode). */
  getActiveLinks(): Array<{ peerId: PlayerId; mode: VoiceMode; state: VoiceState }> {
    return [...this.links.entries()].map(([peerId, l]) => ({ peerId, mode: l.mode, state: l.state }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [peerId, link] of [...this.links.entries()]) {
      this.teardownLink(peerId, link, { renegotiate: false });
    }
    this.releaseMicIfUnused();
    this.remoteStreams.clear();
    this.listeners.clear();
  }

  // ----- internal: negotiation hooks ---------------------------------------

  /**
   * Answerer side, SDP-driven auto-response. Reads the audio direction offered
   * by the remote and configures the local transceiver accordingly:
   * - remote sendrecv (talk)  -> local sendrecv (mic), or recvonly on mic denial
   * - remote recvonly (listen)-> local sendonly (mic), or inactive on mic denial
   * - remote inactive (stop)  -> local inactive
   */
  private async handleRemoteOfferApplied(peerId: PlayerId, rtc: RTCPeerConnection): Promise<void> {
    if (this.disposed) return;
    const remoteDir = this.parseFirstRemoteAudioDirection(rtc.remoteDescription?.sdp ?? "");
    if (!remoteDir) return; // no audio m-line: not a voice renegotiation
    const transceiver = this.findAudioTransceiver(rtc);
    if (!transceiver) return;
    if (remoteDir === "inactive") {
      try { transceiver.direction = "inactive"; } catch {}
      try { transceiver.sender.replaceTrack(null); } catch {}
      return;
    }
    const remoteSends = remoteDir === "sendrecv" || remoteDir === "sendonly";
    const remoteWantsOurAudio = remoteDir === "sendrecv" || remoteDir === "recvonly";
    if (remoteWantsOurAudio) {
      try {
        const track = await this.acquireTrack();
        try { await transceiver.sender.replaceTrack(track); } catch {}
        transceiver.direction = remoteSends ? "sendrecv" : "sendonly";
      } catch (e) {
        // Mic unavailable/denied: degrade gracefully, negotiation still completes
        this.emit("error", peerId, toError(e));
        try { transceiver.sender.replaceTrack(null); } catch {}
        transceiver.direction = remoteSends ? "recvonly" : "inactive";
      }
    } else {
      // remote sendonly: we only receive
      try { transceiver.sender.replaceTrack(null); } catch {}
      transceiver.direction = "recvonly";
    }
  }

  /** Both sides, once signaling is back to "stable". */
  private handleNegotiationSettled(peerId: PlayerId): void {
    if (this.disposed) return;
    const link = this.links.get(peerId);
    if (link) {
      const dir = link.transceiver.currentDirection;
      const pending = link.pendingStart;
      link.pendingStart = undefined;
      if (dir === "inactive" || dir === "stopped" || dir == null) {
        // Negotiated down: remote stopped the link or rejected it entirely
        if (pending) {
          this.setState(peerId, link, "failed");
          pending.reject(new Error(`Voice link to "${peerId}" was rejected by the remote peer`));
        }
        this.removeLink(peerId, link);
        return;
      }
      link.sending = !!link.transceiver.sender.track && (dir === "sendrecv" || dir === "sendonly");
      this.setState(peerId, link, "connected");
      pending?.resolve();
      return;
    }
    // No local link: adopt a remotely-initiated voice link so stop()/cleanup work
    const peer = this.peers.getPeer(peerId);
    if (!peer) return;
    const transceiver = peer.rtc.getTransceivers().find((t) => {
      const cd = t.currentDirection;
      return this.isAudioTransceiver(t) && cd != null && cd !== "inactive" && cd !== "stopped";
    });
    if (!transceiver) return;
    const cd = transceiver.currentDirection;
    const adopted: VoiceLink = {
      mode: cd === "sendrecv" ? "talk" : "listen",
      transceiver,
      state: "connecting",
      sending: !!transceiver.sender.track && (cd === "sendrecv" || cd === "sendonly"),
      remoteStream: this.remoteStreams.get(peerId),
    };
    this.links.set(peerId, adopted);
    this.setState(peerId, adopted, "connected");
  }

  private handleTrack(peerId: PlayerId, ev: RTCTrackEvent): void {
    if (this.disposed) return;
    let stream = ev.streams && ev.streams[0];
    if (!stream) {
      try { stream = new MediaStream([ev.track]); } catch { return; }
    }
    this.remoteStreams.set(peerId, stream);
    const link = this.links.get(peerId);
    if (link) link.remoteStream = stream;
    this.emit("remoteStream", peerId, stream);
  }

  private handlePeerGone(peerId: PlayerId): void {
    if (this.disposed) return;
    const link = this.links.get(peerId);
    if (!link) {
      this.remoteStreams.delete(peerId);
      return;
    }
    // Peer is gone: no renegotiation possible, just clean up local state
    this.teardownLink(peerId, link, { renegotiate: false });
  }

  // ----- internal: helpers ---------------------------------------------------

  private teardownLink(peerId: PlayerId, link: VoiceLink, opts: { renegotiate: boolean }): void {
    link.pendingStart?.reject(new Error(`Voice link to "${peerId}" was stopped`));
    link.pendingStart = undefined;
    try { link.transceiver.direction = "inactive"; } catch {}
    try { link.transceiver.sender.replaceTrack(null); } catch {}
    this.removeLink(peerId, link);
    if (opts.renegotiate) this.peers.renegotiate(peerId).catch(() => {});
  }

  private removeLink(peerId: PlayerId, link: VoiceLink): void {
    this.links.delete(peerId);
    const hadRemote = !!(link.remoteStream ?? this.remoteStreams.get(peerId));
    this.remoteStreams.delete(peerId);
    if (hadRemote) this.emit("remoteStreamRemoved", peerId);
    this.setState(peerId, link, "disconnected");
    this.releaseMicIfUnused();
  }

  private setState(peerId: PlayerId, link: VoiceLink, state: VoiceState): void {
    if (link.state === state) return;
    link.state = state;
    this.emit("state", peerId, state);
  }

  /**
   * Acquire the outgoing audio track. The same track is shared across all peer
   * connections (no cloning). Library-acquired mic tracks are stopped once no
   * link uses them anymore; app-provided streams are never stopped by the lib.
   */
  private async acquireTrack(custom?: MediaStream): Promise<MediaStreamTrack> {
    if (custom) {
      const track = custom.getAudioTracks()[0];
      if (!track) throw new Error("Provided localStream has no audio track");
      track.enabled = !this.muted;
      return track;
    }
    if (!this.sharedMicStream) {
      const mediaDevices = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> } } }).navigator?.mediaDevices;
      if (!mediaDevices?.getUserMedia) throw new Error("getUserMedia is not available in this environment");
      this.sharedMicStream = await mediaDevices.getUserMedia({ audio: true });
    }
    const track = this.sharedMicStream.getAudioTracks()[0];
    if (!track) throw new Error("Microphone stream has no audio track");
    track.enabled = !this.muted;
    return track;
  }

  /** Stop the library-owned mic once no link sends audio anymore (turns off the browser mic indicator). */
  private releaseMicIfUnused(): void {
    if (!this.sharedMicStream) return;
    for (const link of this.links.values()) {
      if (link.sending) return;
    }
    for (const t of this.sharedMicStream.getTracks()) {
      try { t.stop(); } catch {}
    }
    this.sharedMicStream = undefined;
  }

  /** Reuse an inactive audio transceiver from a previous link instead of adding a new m-line. */
  private findReusableAudioTransceiver(rtc: RTCPeerConnection): RTCRtpTransceiver | undefined {
    return rtc.getTransceivers().find((t) => {
      const cd = t.currentDirection;
      return this.isAudioTransceiver(t) && (cd === "inactive" || t.direction === "inactive") && cd !== "stopped";
    });
  }

  private findAudioTransceiver(rtc: RTCPeerConnection): RTCRtpTransceiver | undefined {
    return rtc.getTransceivers().find((t) => this.isAudioTransceiver(t) && t.currentDirection !== "stopped");
  }

  private isAudioTransceiver(t: RTCRtpTransceiver): boolean {
    const kind = t.receiver?.track?.kind ?? t.sender?.track?.kind;
    return kind === undefined || kind === "audio";
  }

  /** Minimal SDP scan: direction of the first m=audio section (defaults to sendrecv per RFC 3264). */
  private parseFirstRemoteAudioDirection(sdp: string): RTCRtpTransceiverDirection | undefined {
    const sections = sdp.split(/\r?\nm=/);
    for (let i = 1; i < sections.length; i++) {
      const section = "m=" + sections[i];
      if (!section.startsWith("m=audio")) continue;
      const match = section.match(/a=(sendrecv|sendonly|recvonly|inactive)/);
      return (match ? match[1] : "sendrecv") as RTCRtpTransceiverDirection;
    }
    return undefined;
  }
}
