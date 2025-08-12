import { EventBus } from "../events/EventBus";
import { PeerManager, SignalingAdapter } from "../net/PeerManager";
import { PingOverlay } from "../overlay/PingOverlay";
import { StateManager } from "../sync/StateManager";
import { MovementSystem } from "./MovementSystem";
import {
  ConflictResolution,
  EventName,
  GameLibOptions,
  GlobalGameState,
  InventoryItem,
  NetMessage,
  PlayerId,
    SharedPayloadMessage,
} from "../types";

export class P2PGameLibrary {
  private readonly bus = new EventBus();
  private readonly state: StateManager;
  private readonly peers: PeerManager;
  private readonly overlay: PingOverlay;
  private readonly movement: MovementSystem;
  private readonly localId: PlayerId;
  private readonly options: Required<Pick<GameLibOptions, "syncStrategy" | "conflictResolution" | "maxPlayers">> & GameLibOptions;

  constructor(options: GameLibOptions & { signaling: SignalingAdapter }) {
    this.options = {
      maxPlayers: options.maxPlayers ?? 4,
      syncStrategy: options.syncStrategy ?? "delta",
      conflictResolution: options.conflictResolution ?? "timestamp",
      ...options,
    };

    this.state = new StateManager(
      this.bus,
      this.options.conflictResolution as ConflictResolution,
      () => this.options.authoritativeClientId,
      () => this.getConnectedPeers(),
      () => this.localId
    );

    this.peers = new PeerManager(
      this.bus,
      options.signaling,
      options.serialization ?? "json",
      options.iceServers,
      options.debug,
      options.backpressure
    );
    this.localId = options.signaling.localId;

    this.overlay = new PingOverlay(this.bus, options.pingOverlay);
    this.movement = new MovementSystem(this.bus, () => this.state.getState(), this.options.movement ?? {});

    // Route network messages to state manager
    this.bus.on("netMessage", (msg: NetMessage) => this.state.handleNetMessage(msg));

    // If authoritative mode and no explicit authoritative id, bind it to current host automatically
    this.bus.on("hostChange", (hostId: PlayerId) => {
      if (
        this.options.conflictResolution === "authoritative" &&
        !this.options.authoritativeClientId
      ) {
        this.options.authoritativeClientId = hostId;
      }
    // When we become host, push a fresh full state to stabilize all peers
      if (hostId === this.localId) {
        this.broadcastFullState(this.localId);
      }
    });

    // When a peer joins, hydrate it with our full state (host only, after hostChange)
    this.bus.on("peerJoin", (peerId: PlayerId) => {
      // micro-task to let hostChange propagate first
      setTimeout(() => {
        const hostIdNow = this.peers.getHostId();
        if (hostIdNow && hostIdNow === this.localId) {
          const msg: NetMessage = {
            t: "state_full",
            from: this.localId,
            ts: performance.now(),
            state: this.state.getState(),
          } as any;
          this.peers.send(peerId, msg);
        }
      }, 0);
    });

    // Cleanup option: if we are the host, remove the leaving player and broadcast
    this.bus.on("peerLeave", (peerId: PlayerId) => {
      const hostId = this.peers.getHostId();
      if (hostId && hostId === this.localId && this.options.cleanupOnPeerLeave) {
        const st = this.state.getState();
        delete (st.players as any)[peerId];
        delete (st.inventories as any)[peerId];
        this.broadcastDelta(this.localId, [
          `players.${peerId}`,
          `inventories.${peerId}`
        ]);
      }
    });
  }

  async start(): Promise<void> {
    await this.peers.createOrJoin();
  }

  on<N extends EventName>(name: N, fn: (EventParameters: any) => void) {
    return this.bus.on(name as any, fn as any);
  }

  getState(): GlobalGameState {
    return this.state.getState();
  }

  /**
   * Convenience: mutate local state at given paths and broadcast the corresponding delta.
   * Returns the computed paths used for the delta.
   */
  setStateAndBroadcast(selfId: PlayerId, changes: Array<{ path: string; value: unknown }>): string[] {
    this.state.setPathsValues(changes);
    const paths = changes.map((c) => c.path);
    this.broadcastDelta(selfId, paths);
    return paths;
  }

  // Movement API
  broadcastMove(selfId: PlayerId, position: { x: number; y: number }, velocity?: { x: number; y: number }) {
    const msg: NetMessage = { t: "move", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), position, velocity } as any;
    this.peers.broadcast(msg);
  }

  // Presence API: ensure local player exists and broadcast a no-op move to announce presence
  announcePresence(selfId: PlayerId, position: { x: number; y: number } = { x: 0, y: 0 }) {
    const st = this.state.getState();
    if (!st.players[selfId]) {
      st.players[selfId] = { id: selfId, position: { ...position } } as any;
    }
    const msg: NetMessage = { t: "move", from: selfId, ts: performance.now(), position } as any;
    this.peers.broadcast(msg);
  }

  // Inventory API
  updateInventory(selfId: PlayerId, items: InventoryItem[]) {
    const msg: NetMessage = { t: "inventory", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), items } as any;
    this.peers.broadcast(msg);
  }

  // Transfer API
  transferItem(selfId: PlayerId, to: PlayerId, item: InventoryItem) {
    const msg: NetMessage = { t: "transfer", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), to, item } as any;
    this.peers.broadcast(msg);
  }

  // Generic payload sharing API (broadcast)
  broadcastPayload(selfId: PlayerId, payload: unknown, channel?: string) {
    const msg: SharedPayloadMessage = { t: "payload", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), payload, channel };
    this.peers.broadcast(msg as unknown as NetMessage);
  }

  // Generic payload sharing API (targeted)
  sendPayload(selfId: PlayerId, to: PlayerId, payload: unknown, channel?: string) {
    const msg: SharedPayloadMessage = { t: "payload", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), payload, channel };
    this.peers.send(to, msg as unknown as NetMessage);
  }

  // State sync strategies
  broadcastFullState(selfId: PlayerId) {
    const msg: NetMessage = { t: "state_full", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), state: this.state.getState() } as any;
    this.peers.broadcast(msg);
  }

  broadcastDelta(selfId: PlayerId, paths: string[]) {
    const delta = this.state.buildDeltaFromPaths(paths);
    const msg: NetMessage = { t: "state_delta", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), delta } as any;
    this.peers.broadcast(msg);
  }

  setPingOverlayEnabled(enabled: boolean) {
    this.overlay.setEnabled(enabled);
  }

  private getConnectedPeers(): PlayerId[] {
    return this.peers.getPeerIds();
  }

  // Game loop helpers
  tick(now = performance.now()) {
    this.movement.interpolate(now);
    this.movement.resolveCollisions();
  }

  getHostId(): PlayerId | undefined {
    return this.peers.getHostId();
  }

  // Sequence generator per local sender
  private seqCounters: Record<string, number> = {};
  private nextSeq(sender: PlayerId): number {
    const v = (this.seqCounters[sender] ?? 0) + 1;
    this.seqCounters[sender] = v;
    return v;
  }
}

