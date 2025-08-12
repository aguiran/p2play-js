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
    if ((this as any)._wired) return;
    (this as any)._wired = true;
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg: any = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
        if (!msg || msg.roomId !== this.roomId) return;
        if (msg.sys === 'roster') {
          const roster = Array.isArray(msg.roster) ? (msg.roster as PlayerId[]) : [];
          this.rosterHandlers.forEach((h) => h(roster));
          return;
        }
        if (msg.from === this.localId) return;
        if (msg.kind === "desc") this.descHandlers.forEach((h) => h(msg.payload, msg.from));
        if (msg.kind === "ice") this.iceHandlers.forEach((h) => h(msg.payload, msg.from));
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
}