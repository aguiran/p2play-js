import type { NetMessage } from "../types";

/**
 * Runtime guard for NetMessage envelopes (anti-spoofing / invalid message rejection).
 * Verifies required base fields (t, from, ts) and per-type structure.
 * Used by StateManager.handleNetMessage to reject malformed or unknown messages
 * before they reach application logic.
 */
export function isValidNetMessage(msg: unknown): msg is NetMessage {
  if (msg === null || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.t !== "string" || typeof m.from !== "string" || typeof m.ts !== "number") return false;
  switch (m.t) {
    case "move": {
      const pos = m.position;
      return pos !== null && typeof pos === "object" && typeof (pos as Record<string, unknown>).x === "number" && typeof (pos as Record<string, unknown>).y === "number";
    }
    case "inventory":
      return Array.isArray(m.items);
    case "transfer": {
      if (typeof m.to !== "string" || m.item === null || typeof m.item !== "object") return false;
      const item = m.item as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.quantity === "number";
    }
    case "state_full":
      return m.state !== null && typeof m.state === "object";
    case "state_delta":
      return m.delta !== null && typeof m.delta === "object";
    case "payload":
      return true;
    default:
      return false;
  }
}
