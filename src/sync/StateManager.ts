import { ConflictResolver } from "./ConflictResolver";
import {
  ConflictResolution,
  DebugOptions,
  DeltaStateMessage,
  FullStateMessage,
  GlobalGameState,
  NetMessage,
  PlayerId,
  StateDelta,
} from "../types";
import { EventBus } from "../events/EventBus";
import { isValidNetMessage } from "../net/netMessageGuards";

export class StateManager {
  private state: GlobalGameState;
  private bus: EventBus;
  private resolver: ConflictResolver;
  private getLocalId: () => PlayerId | undefined;
  private lastAppliedSeq: Map<PlayerId, number> = new Map();
  private debug: DebugOptions;

  constructor(
    bus: EventBus,
    mode: ConflictResolution,
    getAuthoritativeId: () => PlayerId | undefined,
    getMajority: () => PlayerId[],
    getLocalId: () => PlayerId | undefined,
    debug?: DebugOptions
  ) {
    this.bus = bus;
    this.debug = debug ?? {};
    this.state = {
      players: {},
      inventories: {},
      objects: {},
      tick: 0,
    };
    this.resolver = new ConflictResolver(mode, getAuthoritativeId, getMajority);
    this.getLocalId = getLocalId;
  }

  getState(): GlobalGameState {
    return this.state;
  }

  /**
   * Apply a set of path-based changes to the local state without emitting network traffic.
   * Use together with broadcastDelta(paths) to propagate to peers.
   */
  setPathsValues(changes: Array<{ path: string; value: unknown }>): void {
    for (const change of changes) {
      const segments = change.path.split(".");
      let cursor: Record<string, unknown> = this.state as unknown as Record<string, unknown>;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        cursor = (cursor[seg] ?? (cursor[seg] = {})) as Record<string, unknown>;
      }
      cursor[segments[segments.length - 1]] = structuredClone(change.value);
    }
  }

  applyFullState(msg: FullStateMessage) {
    const incoming = msg.state;
    const localId = this.getLocalId();
    // Merge with overwrite for remote players to realign diverged states (keep local player's live state)
    for (const [pid, pstate] of Object.entries(incoming.players)) {
      if (pid === localId) continue;
      this.state.players[pid] = structuredClone(pstate);
    }
    for (const [pid, items] of Object.entries(incoming.inventories)) {
      if (pid === localId) continue;
      this.state.inventories[pid] = items.map((it) => ({ ...it }));
    }
    // If this is an initial join/rejoin (no seq seen for local), accept host snapshot for localId too
    if (localId && this.lastAppliedSeq.get(localId) === undefined) {
      const localIncoming = incoming.players[localId];
      if (localIncoming) this.state.players[localId] = structuredClone(localIncoming);
      const localInv = incoming.inventories[localId];
      if (localInv) this.state.inventories[localId] = localInv.map((it) => ({ ...it }));
    }
    // Objects: replace wholesale (not player-owned)
    this.state.objects = structuredClone(incoming.objects);
    // Tick: take the max
    this.state.tick = Math.max(this.state.tick, incoming.tick);
    this.bus.emit("stateSync", this.state);
  }

  applyDeltaMessage(msg: DeltaStateMessage) {
    this.resolver.applyDelta(this.state, msg.delta);
    this.bus.emit("stateDelta", msg.delta);
  }

  handleNetMessage(msg: NetMessage) {
    if (!isValidNetMessage(msg as unknown)) {
      if (this.debug.enabled) {
        const m = msg as unknown as Record<string, unknown> | null;
        console.debug("[p2play] netMessage rejected", {
          t: m && typeof m === "object" ? m.t : undefined,
          from: m && typeof m === "object" ? m.from : undefined,
        });
      }
      return;
    }
    // Drop old/duplicate messages using per-sender sequence
    if (msg.seq !== undefined) {
      const last = this.lastAppliedSeq.get(msg.from) ?? -1;
      if (msg.seq <= last) return; // stale or duplicate
      this.lastAppliedSeq.set(msg.from, msg.seq);
    }
    switch (msg.t) {
      case "move": {
        const accepted = this.resolver.resolveMove(this.state, msg);
        if (accepted) this.bus.emit("playerMove", msg.from, msg.position);
        break;
      }
      case "inventory": {
        const accepted = this.resolver.resolveInventory(this.state, msg);
        if (accepted) this.bus.emit("inventoryUpdate", msg.from, msg.items);
        break;
      }
      case "transfer": {
        const ok = this.resolver.resolveTransfer(this.state, msg);
        if (ok) this.bus.emit("objectTransfer", msg.from, msg.to, msg.item);
        break;
      }
      case "state_full":
        this.applyFullState(msg);
        break;
      case "state_delta":
        this.applyDeltaMessage(msg);
        break;
      case "payload":
        this.bus.emit("sharedPayload", msg.from, msg.payload, msg.channel);
        break;
    }
  }

  buildDeltaFromPaths(paths: string[]): StateDelta {
    const changes = paths.map((path) => ({ path, value: this.getPathValue(path) }));
    return { tick: ++this.state.tick, changes };
  }

  private getPathValue(path: string): unknown {
    const segments = path.split(".");
    let cursor: Record<string, unknown> | undefined = this.state as unknown as Record<string, unknown>;
    for (const seg of segments) {
      cursor = cursor === undefined ? undefined : (cursor[seg] as Record<string, unknown> | undefined);
    }
    return structuredClone(cursor);
  }
}

