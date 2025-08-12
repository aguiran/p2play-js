import { ConflictResolver } from "./ConflictResolver";
import {
  ConflictResolution,
  DeltaStateMessage,
  FullStateMessage,
  GlobalGameState,
  InventoryUpdateMessage,
  MoveMessage,
  NetMessage,
    SharedPayloadMessage,
  PlayerId,
  StateDelta,
} from "../types";
import { EventBus } from "../events/EventBus";

export class StateManager {
  private state: GlobalGameState;
  private bus: EventBus;
  private resolver: ConflictResolver;
  private getLocalId: () => PlayerId | undefined;
  private lastAppliedSeq: Map<PlayerId, number> = new Map();

  constructor(
    bus: EventBus,
    mode: ConflictResolution,
    getAuthoritativeId: () => PlayerId | undefined,
    getMajority: () => PlayerId[],
    getLocalId: () => PlayerId | undefined
  ) {
    this.bus = bus;
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
      let cursor: any = this.state as any;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        cursor = cursor[seg] ?? (cursor[seg] = {});
      }
      cursor[segments[segments.length - 1]] = structuredClone(change.value);
    }
  }

  applyFullState(msg: FullStateMessage) {
    const incoming = msg.state;
    const localId = this.getLocalId();
    // Merge instead of replace to avoid resetting local player's state
    // Players: add missing only (avoid resetting existing views)
    for (const [pid, pstate] of Object.entries(incoming.players)) {
      if (pid === localId) continue;
      if (!this.state.players[pid]) {
        this.state.players[pid] = structuredClone(pstate);
      }
    }
    // Inventories: add missing only
    for (const [pid, items] of Object.entries(incoming.inventories)) {
      if (pid === localId) continue;
      if (!this.state.inventories[pid]) {
        this.state.inventories[pid] = items.map((it) => ({ ...it }));
      }
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
    // Drop old/duplicate messages using per-sender sequence
    if (msg.seq !== undefined) {
      const last = this.lastAppliedSeq.get(msg.from) ?? -1;
      if (msg.seq <= last) return; // stale or duplicate
      this.lastAppliedSeq.set(msg.from, msg.seq);
    }
    switch (msg.t) {
      case "move": {
        const accepted = this.resolver.resolveMove(this.state, msg as MoveMessage);
        if (accepted) this.bus.emit("playerMove", msg.from, (msg as MoveMessage).position);
        break;
      }
      case "inventory": {
        const accepted = this.resolver.resolveInventory(this.state, msg as InventoryUpdateMessage);
        if (accepted) this.bus.emit("inventoryUpdate", msg.from, (msg as InventoryUpdateMessage).items);
        break;
      }
      case "transfer": {
        const ok = this.resolver.resolveTransfer(this.state, msg);
        if (ok) this.bus.emit("objectTransfer", msg.from, msg.to, msg.item);
        break;
      }
      case "state_full":
        this.applyFullState(msg as FullStateMessage);
        break;
      case "state_delta":
        this.applyDeltaMessage(msg as DeltaStateMessage);
        break;
      case "payload": {
        const m = msg as SharedPayloadMessage;
        this.bus.emit("sharedPayload", m.from, m.payload, m.channel);
        break;
      }
    }
  }

  buildDeltaFromPaths(paths: string[]): StateDelta {
    const changes = paths.map((path) => ({ path, value: this.getPathValue(path) }));
    return { tick: ++this.state.tick, changes };
  }

  private getPathValue(path: string): any {
    const segments = path.split(".");
    let cursor: any = this.state as any;
    for (const seg of segments) cursor = cursor?.[seg];
    return structuredClone(cursor);
  }
}

