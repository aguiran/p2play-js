/**
 * Internal path utilities for dot-separated paths (e.g. "a.b.c").
 * Used by StateManager and ConflictResolver. Not exported from the public API.
 */

export function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    cursor = (cursor[seg] ?? (cursor[seg] = {})) as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}
