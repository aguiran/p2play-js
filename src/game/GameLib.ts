import { EventBus } from "../events/EventBus";
import { PeerManager, SignalingAdapter } from "../net/PeerManager";
import { PingOverlay } from "../overlay/PingOverlay";
import { StateManager } from "../sync/StateManager";
import { MovementSystem } from "./MovementSystem";
import {
  DeltaStateMessage,
  EventHandlerMap,
  EventName,
  FullStateMessage,
  GameLibOptions,
  GlobalGameState,
  InventoryItem,
  InventoryUpdateMessage,
  MoveMessage,
  NetMessage,
  ObjectTransferMessage,
  PlayerId,
  SendOptions,
  SharedPayloadMessage,
} from "../types";

export class P2PGameLibrary {
  private readonly bus = new EventBus();
  private readonly state: StateManager;
  private readonly peers: PeerManager;
  private readonly overlay: PingOverlay;
  private readonly movement: MovementSystem;
  private readonly localId: PlayerId;
  private readonly signaling: SignalingAdapter;
  private readonly options: Required<Pick<GameLibOptions, "conflictResolution" | "maxPlayers">> & GameLibOptions;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(options: GameLibOptions & { signaling: SignalingAdapter }) {
    this.signaling = options.signaling;
    this.options = {
      maxPlayers: options.maxPlayers ?? 4,
      conflictResolution: options.conflictResolution ?? "timestamp",
      ...options,
    };

    this.state = new StateManager(
      this.bus,
      this.options.conflictResolution,
      () => this.localId,
      options.debug
    );

    this.peers = new PeerManager(
      this.bus,
      options.signaling,
      options.serialization ?? "json",
      options.iceServers,
      options.debug,
      options.backpressure,
      this.options.maxPlayers,
      options.timing
    );
    this.localId = options.signaling.localId;

    this.overlay = new PingOverlay(this.bus, options.pingOverlay);
    this.movement = new MovementSystem(this.bus, () => this.state.getState(), this.options.movement ?? {}, () => this.localId);

    // Route network messages to state manager
    this.unsubs.push(this.bus.on("netMessage", (msg: NetMessage) => this.state.handleNetMessage(msg)));

    // When we become host, push a fresh full state to stabilize all peers
    this.unsubs.push(this.bus.on("hostChange", (hostId: PlayerId) => {
      if (hostId === this.localId) {
        this.broadcastFullState(this.localId);
      }
    }));

    // When a peer joins, hydrate it with our full state (host only, after hostChange)
    this.unsubs.push(this.bus.on("peerJoin", (peerId: PlayerId) => {
      // micro-task to let hostChange propagate first
      setTimeout(() => {
        const hostIdNow = this.peers.getHostId();
        if (hostIdNow && hostIdNow === this.localId) {
          const msg: FullStateMessage = {
            t: "state_full",
            from: this.localId,
            ts: performance.now(),
            state: this.state.getState(),
          };
          this.peers.send(peerId, msg);
        }
      }, 0);
    }));

    // Cleanup option: if we are the host, remove the leaving player and broadcast
    this.unsubs.push(this.bus.on("peerLeave", (peerId: PlayerId) => {
      const hostId = this.peers.getHostId();
      if (hostId && hostId === this.localId && this.options.cleanupOnPeerLeave) {
        const st = this.state.getState();
        delete st.players[peerId];
        delete st.inventories[peerId];
        this.broadcastDelta(this.localId, [
          `players.${peerId}`,
          `inventories.${peerId}`
        ]);
      }
    }));
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.peers.dispose();
    this.signaling?.close?.();
    this.overlay.dispose();
    this.movement.dispose();
    this.bus.clear();
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    await this.peers.createOrJoin();
    const sig = this.signaling as { setReconnectCallbacks?: (onDisconnect: () => void, onReconnect: () => void) => void };
    if (typeof sig.setReconnectCallbacks === "function") {
      sig.setReconnectCallbacks(
        () => this.peers.handleSignalingDisconnect(),
        () => this.state.prepareForResync()
      );
    }
  }

  on<N extends EventName>(name: N, fn: EventHandlerMap[N]): () => void {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    return this.bus.on(name, fn);
  }

  /** Returns a deep copy of the current game state. Mutations on this object do not affect the internal state. Use setStateAndBroadcast(), broadcastMove(), announcePresence(), etc. to mutate and sync state. */
  getState(): GlobalGameState {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    return structuredClone(this.state.getState());
  }

  /**
   * Convenience: mutate local state at given paths and broadcast the corresponding delta.
   * Returns the computed paths used for the delta.
   */
  setStateAndBroadcast(selfId: PlayerId, changes: Array<{ path: string; value: unknown }>): string[] {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    this.state.setPathsValues(changes);
    const paths = changes.map((c) => c.path);
    this.broadcastDelta(selfId, paths);
    return paths;
  }

  // Movement API
  broadcastMove(selfId: PlayerId, position: { x: number; y: number }, velocity?: { x: number; y: number }) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const st = this.state.getState();
    const player = (st.players[selfId] = st.players[selfId] ?? { id: selfId, position: { x: 0, y: 0 } });
    player.position = { ...player.position, ...position };
    if (velocity) player.velocity = { ...player.velocity, ...velocity };
    const msg: MoveMessage = { t: "move", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), position, velocity };
    this.peers.broadcast(msg);
  }

  // Presence API: ensure local player exists (or update position) and broadcast a move to announce presence
  announcePresence(selfId: PlayerId, position: { x: number; y: number } = { x: 0, y: 0 }) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const st = this.state.getState();
    const player = (st.players[selfId] = st.players[selfId] ?? { id: selfId, position: { x: 0, y: 0 } });
    player.position = { ...player.position, ...position };
    const msg: MoveMessage = { t: "move", from: selfId, ts: performance.now(), position };
    this.peers.broadcast(msg);
  }

  // Inventory API
  updateInventory(selfId: PlayerId, items: InventoryItem[], options?: SendOptions) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const msg: InventoryUpdateMessage = { t: "inventory", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), items };
    this.peers.broadcast(msg, options);
  }

  // Transfer API
  transferItem(selfId: PlayerId, to: PlayerId, item: InventoryItem, options?: SendOptions) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const msg: ObjectTransferMessage = { t: "transfer", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), to, item };
    this.peers.broadcast(msg, options);
  }

  // Generic payload sharing API (broadcast)
  broadcastPayload(selfId: PlayerId, payload: unknown, channel?: string, options?: SendOptions) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const msg: SharedPayloadMessage = { t: "payload", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), payload, channel };
    this.peers.broadcast(msg, options);
  }

  // Generic payload sharing API (targeted)
  sendPayload(selfId: PlayerId, to: PlayerId, payload: unknown, channel?: string, options?: SendOptions) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const msg: SharedPayloadMessage = { t: "payload", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), payload, channel };
    this.peers.send(to, msg, options);
  }

  // State sync strategies
  broadcastFullState(selfId: PlayerId) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const msg: FullStateMessage = { t: "state_full", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), state: this.state.getState() };
    this.peers.broadcast(msg);
  }

  broadcastDelta(selfId: PlayerId, paths: string[]) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    const delta = this.state.buildDeltaFromPaths(paths);
    const msg: DeltaStateMessage = { t: "state_delta", from: selfId, ts: performance.now(), seq: this.nextSeq(selfId), delta };
    this.peers.broadcast(msg);
  }

  setPingOverlayEnabled(enabled: boolean) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    this.overlay.setEnabled(enabled);
  }

  // Game loop helpers
  tick(now = performance.now()) {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
    this.movement.interpolate(now);
    this.movement.resolveCollisions();
  }

  getHostId(): PlayerId | undefined {
    if (this.disposed) throw new Error("P2PGameLibrary has been disposed");
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

