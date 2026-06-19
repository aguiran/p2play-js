/**
 * Internal path utilities for dot-separated paths (e.g. "a.b.c").
 * Used by StateManager and ConflictResolver. Not exported from the public API.
 */

// Keys that would let a remote-controlled path escape the target object and
// walk into the prototype chain (prototype pollution). Paths containing any of
// these segments are rejected since state deltas can originate from untrusted peers.
const FORBIDDEN_KEYS = new Set<string>(["__proto__", "prototype", "constructor"]);

function isUnsafeSegment(seg: string): boolean {
  return FORBIDDEN_KEYS.has(seg);
}

export function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (isUnsafeSegment(seg)) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  if (segments.length === 0) return;
  // Reject the whole path if any segment could pollute the prototype chain.
  if (segments.some(isUnsafeSegment)) return;
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    cursor = (cursor[seg] ?? (cursor[seg] = {})) as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}
