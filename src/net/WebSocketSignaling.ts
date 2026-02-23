import { PlayerId } from "../types";
import { SignalingAdapter } from "./PeerManager";

type SignalEnvelope = {
  kind: "desc" | "ice";
  roomId: string;
  from: PlayerId;
  to?: PlayerId;
  payload: any;
  announce?: boolean;
};

export class WebSocketSignaling implements SignalingAdapter {
  public ws: WebSocket;
  private _wired = false;
  private descHandlers: Array<(desc: RTCSessionDescriptionInit, from: PlayerId) => void> = [];
  private iceHandlers: Array<(candidate: RTCIceCandidateInit, from: PlayerId) => void> = [];
  private rosterHandlers: Array<(roster: PlayerId[]) => void> = [];
  private isOpen!: Promise<void>;

  constructor(public localId: PlayerId, public roomId: string, serverUrl: string) {
    this.ws = new WebSocket(serverUrl);
    this.isOpen = new Promise((resolve) => {
      this.ws.addEventListener("open", () => resolve());
    });
    this.ensureWired();
  }

  private ensureWired() {
    if (this._wired) return;
    this._wired = true;
    this.ws.addEventListener("message", (ev) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data : "{}";
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (!msg || msg.roomId !== this.roomId) return;
        if (msg.sys === "roster") {
          const roster = Array.isArray(msg.roster) ? (msg.roster as PlayerId[]) : [];
          this.rosterHandlers.forEach((h) => h(roster));
          return;
        }
        if (typeof msg.from !== "string") return;
        if (msg.from === this.localId) return;
        const from = msg.from as PlayerId;
        if (msg.kind === "desc" && msg.payload != null) this.descHandlers.forEach((h) => h(msg.payload as RTCSessionDescriptionInit, from));
        if (msg.kind === "ice" && msg.payload != null) this.iceHandlers.forEach((h) => h(msg.payload as RTCIceCandidateInit, from));
      } catch {
        // ignore
      }
    });
  }

  async register(): Promise<void> {
    await this.isOpen;
    // Send a lightweight registration message to join room and receive roster
    this.ws.send(JSON.stringify({ roomId: this.roomId, from: this.localId, announce: true, kind: 'register' }));
  }

  async announce(localDescription: RTCSessionDescriptionInit, to?: PlayerId): Promise<void> {
    await this.isOpen;
    this.ensureWired();
    const env: SignalEnvelope = {
      kind: "desc",
      roomId: this.roomId,
      from: this.localId,
      to,
      payload: localDescription,
      announce: true,
    };
    this.ws.send(JSON.stringify(env));
  }

  onRemoteDescription(cb: (desc: RTCSessionDescriptionInit, from: PlayerId) => void): void {
    this.ensureWired();
    this.descHandlers.push(cb);
  }

  onIceCandidate(cb: (candidate: RTCIceCandidateInit, from: PlayerId) => void): void {
    this.ensureWired();
    this.iceHandlers.push(cb);
  }

  onRoster(cb: (roster: PlayerId[]) => void): void {
    this.ensureWired();
    this.rosterHandlers.push(cb);
  }

  async sendIceCandidate(candidate: RTCIceCandidateInit, to?: PlayerId): Promise<void> {
    await this.isOpen;
    this.ensureWired();
    const env: SignalEnvelope = {
      kind: "ice",
      roomId: this.roomId,
      from: this.localId,
      to,
      payload: candidate,
    };
    this.ws.send(JSON.stringify(env));
  }

  close(): void {
    this.descHandlers.length = 0;
    this.iceHandlers.length = 0;
    this.rosterHandlers.length = 0;
    this.ws.close();
  }
}