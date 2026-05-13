import { ConflictResolution, GlobalGameState, NetMessage, StateDelta } from "../types";
import { setAtPath } from "./pathUtils";

export class ConflictResolver {
  constructor(_mode: ConflictResolution) {}

  // Movement: each sender owns updates for their own position/velocity.
  resolveMove(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "move") return false;
    // Last-writer-wins by per-sender sequence (checked in StateManager)
    const player = (current.players[msg.from] =
      current.players[msg.from] ?? { id: msg.from, position: { x: 0, y: 0 } });
    // Message ordering is enforced in StateManager via per-sender sequence.
    if (msg.position) player.position = { ...player.position, ...msg.position };
    if (msg.velocity) player.velocity = { ...player.velocity, ...msg.velocity };
    return true;
  }

  // Inventory: last-writer-wins per player
  resolveInventory(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "inventory") return false;
    current.inventories[msg.from] = msg.items.map((it) => ({ ...it }));
    return true;
  }

  // Transfer: ensure item exists in sender's inventory
  resolveTransfer(current: GlobalGameState, msg: NetMessage): boolean {
    if (msg.t !== "transfer") return false;
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
    for (const change of delta.changes) {
      setAtPath(current as unknown as Record<string, unknown>, change.path, structuredClone(change.value));
    }
    current.tick = Math.max(current.tick, delta.tick);
  }
}

