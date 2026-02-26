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

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.25;

export class WebSocketSignaling implements SignalingAdapter {
  public ws: WebSocket;
  private _wired = false;
  private descHandlers: Array<(desc: RTCSessionDescriptionInit, from: PlayerId) => void> = [];
  private iceHandlers: Array<(candidate: RTCIceCandidateInit, from: PlayerId) => void> = [];
  private rosterHandlers: Array<(roster: PlayerId[]) => void> = [];
  private isOpen!: Promise<void>;
  private readonly serverUrl: string;
  private readonly reconnect: boolean;
  private closedIntentionally = false;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private onDisconnectCb: (() => void) | undefined;
  private onReconnectCb: (() => void) | undefined;

  constructor(
    public localId: PlayerId,
    public roomId: string,
    serverUrl: string,
    options?: { reconnect?: boolean }
  ) {
    this.serverUrl = serverUrl;
    this.reconnect = options?.reconnect ?? false;
    this.ws = new WebSocket(serverUrl);
    this.isOpen = new Promise((resolve) => {
      this.ws.addEventListener("open", () => resolve());
    });
    this.ensureWired();
    this.ws.addEventListener("close", () => this.handleClose());
    this.ws.addEventListener("error", () => this.handleClose());
  }

  setReconnectCallbacks(onDisconnect?: () => void, onReconnect?: () => void): void {
    this.onDisconnectCb = onDisconnect;
    this.onReconnectCb = onReconnect;
  }

  get isReconnecting(): boolean {
    return this.reconnectTimeoutId !== undefined;
  }

  private handleClose(): void {
    if (this.closedIntentionally || !this.reconnect) return;
    this.onDisconnectCb?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedIntentionally || this.reconnectTimeoutId !== undefined) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt)
    );
    const jitter = 1 + Math.random() * RECONNECT_JITTER;
    const ms = Math.round(delay * jitter);
    this.reconnectAttempt++;
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = undefined;
      this.doReconnect();
    }, ms);
  }

  private doReconnect(): void {
    if (this.closedIntentionally) return;
    this.ws = new WebSocket(this.serverUrl);
    this.isOpen = new Promise((resolve) => {
      this.ws.addEventListener("open", () => {
        if (this.closedIntentionally) {
          resolve();
          return;
        }
        this.reconnectAttempt = 0;
        this._wired = false;
        this.ensureWired();
        this.register().then(() => {
          if (!this.closedIntentionally) this.onReconnectCb?.();
        });
        resolve();
      });
    });
    this.ws.addEventListener("close", () => this.handleClose());
    this.ws.addEventListener("error", () => this.handleClose());
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
    this.closedIntentionally = true;
    if (this.reconnectTimeoutId !== undefined) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = undefined;
    }
    this.descHandlers.length = 0;
    this.iceHandlers.length = 0;
    this.rosterHandlers.length = 0;
    this.ws.close();
  }
}