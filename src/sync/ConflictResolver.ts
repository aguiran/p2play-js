import { ConflictResolution, GlobalGameState, NetMessage, PlayerId, StateDelta } from "../types";

export class ConflictResolver {
  constructor(
    private mode: ConflictResolution,
    private getAuthoritativeId: () => PlayerId | undefined,
    private getMajority: () => PlayerId[]
  ) {}

  // For movement: keep-latest by timestamp or authoritative override
  resolveMove(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "move") return false;
    if (this.mode === "authoritative") {
      const auth = this.getAuthoritativeId();
      if (auth && msg.from !== auth) return false; // ignore non-authoritative
    }
    // Last-writer-wins by per-sender sequence (checked in StateManager)
    const player = (current.players[msg.from] =
      current.players[msg.from] ?? { id: msg.from, position: { x: 0, y: 0 } });
    // Apply authoritatively only if message seq is higher (handled in StateManager) and prefer provided fields
    if (msg.position) player.position = { ...player.position, ...msg.position };
    if (msg.velocity) player.velocity = { ...player.velocity, ...msg.velocity };
    return true;
  }

  // Inventory: apply last-writer-wins
  resolveInventory(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "inventory") return false;
    if (this.mode === "authoritative") {
      const auth = this.getAuthoritativeId();
      if (auth && msg.from !== auth) return false;
    }
    current.inventories[msg.from] = msg.items.map((it) => ({ ...it }));
    return true;
  }

  // Transfer: ensure item exists in from inventory
  resolveTransfer(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "transfer") return false;
    if (this.mode === "authoritative") {
      const auth = this.getAuthoritativeId();
      if (auth && msg.from !== auth) return false;
    }
    const fromInv = current.inventories[msg.from] ?? [];
    const toInv = current.inventories[msg.to] ?? [];
    const idx = fromInv.findIndex((i) => i.id === msg.item.id);
    if (idx === -1) return false;
    const item = fromInv[idx];
    if (item.quantity < msg.item.quantity) return false;
    item.quantity -= msg.item.quantity;
    if (item.quantity === 0) fromInv.splice(idx, 1);
    const existing = toInv.find((i) => i.id === msg.item.id);
    if (existing) existing.quantity += msg.item.quantity;
    else toInv.push({ ...msg.item });
    current.inventories[msg.from] = fromInv;
    current.inventories[msg.to] = toInv;
    return true;
  }

  applyDelta(current: GlobalGameState, delta: StateDelta) {
    // Very simple JSON path applier: path form a.b.c with no arrays
    for (const change of delta.changes) {
      const segments = change.path.split(".");
      let cursor: Record<string, unknown> = current as unknown as Record<string, unknown>;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        cursor = (cursor[seg] ?? (cursor[seg] = {})) as Record<string, unknown>;
      }
      cursor[segments[segments.length - 1]] = structuredClone(change.value);
    }
    current.tick = Math.max(current.tick, delta.tick);
  }
}

