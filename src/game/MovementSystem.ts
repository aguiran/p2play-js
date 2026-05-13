import { EventBus } from "../events/EventBus";
import { GlobalGameState, MovementOptions, PlayerId } from "../types";

export class MovementSystem {
  private cfg: Required<MovementOptions>;
  private lastMoveTsByPlayer: Map<PlayerId, number> = new Map();
  private lastFrameTsByPlayer: Map<PlayerId, number> = new Map();
  private unsub: () => void;
  private localId: () => PlayerId | undefined;

  constructor(private bus: EventBus, private state: () => GlobalGameState, cfg: MovementOptions = {}, localId?: () => PlayerId | undefined) {
    this.localId = localId ?? (() => undefined);
    this.cfg = {
      maxSpeed: cfg.maxSpeed ?? 400,
      smoothing: cfg.smoothing ?? 0.2,
      extrapolationMs: cfg.extrapolationMs ?? 120,
      worldBounds: cfg.worldBounds ?? { width: 2000, height: 2000 },
      ignoreWorldBounds: cfg.ignoreWorldBounds ?? false,
      playerRadius: cfg.playerRadius ?? 16,
    } as Required<MovementOptions>;

    this.unsub = this.bus.on("playerMove", (playerId: PlayerId) => {
      try {
        const now = performance.now();
        this.lastMoveTsByPlayer.set(playerId, now);
        this.lastFrameTsByPlayer.set(playerId, now);
      } catch (error) {
        console.warn(`Failed to update movement timestamps for player ${playerId}:`, error);
      }
    });
  }

  dispose(): void {
    this.unsub();
    this.lastMoveTsByPlayer.clear();
    this.lastFrameTsByPlayer.clear();
  }

  // Interpolate towards new remote positions to reduce jitter (3D)
  interpolate(now: number) {
    const gs = this.state();
    for (const player of Object.values(gs.players)) {
      const lastMoveTs = this.lastMoveTsByPlayer.get(player.id);
      const lastFrameTs = this.lastFrameTsByPlayer.get(player.id) ?? now;

      // No movement info received yet for this player
      if (lastMoveTs === undefined || !player.velocity) {
        this.lastFrameTsByPlayer.set(player.id, now);
        continue;
      }

      const frameDtSec = Math.max(0, (now - lastFrameTs) / 1000);
      // Additional extrapolation budget remaining relative to the last frame we advanced
      const alreadyExtrapolatedMs = Math.max(0, lastFrameTs - lastMoveTs);
      const remainingMs = Math.max(0, this.cfg.extrapolationMs - alreadyExtrapolatedMs);
      const allowedDtSec = Math.max(0, Math.min(frameDtSec, remainingMs / 1000));

      if (allowedDtSec > 0) {
        const vx = Math.max(-this.cfg.maxSpeed, Math.min(this.cfg.maxSpeed, player.velocity.x));
        const vy = Math.max(-this.cfg.maxSpeed, Math.min(this.cfg.maxSpeed, player.velocity.y));
        const vzRaw = player.velocity.z ?? 0;
        const vz = Math.max(-this.cfg.maxSpeed, Math.min(this.cfg.maxSpeed, vzRaw));
        const nextX = player.position.x + vx * allowedDtSec * this.cfg.smoothing;
        const nextY = player.position.y + vy * allowedDtSec * this.cfg.smoothing;
        const nextZ = (player.position.z ?? 0) + vz * allowedDtSec * this.cfg.smoothing;
        if (this.cfg.ignoreWorldBounds === true) {
          // No clamping at all: open world
          player.position.x = nextX;
          player.position.y = nextY;
          player.position.z = nextZ;
        } else {
          player.position.x = Math.max(0, Math.min(this.cfg.worldBounds.width, nextX));
          player.position.y = Math.max(0, Math.min(this.cfg.worldBounds.height, nextY));
          const depth = this.cfg.worldBounds.depth ?? 0;
          if (depth > 0) {
            player.position.z = Math.max(0, Math.min(depth, nextZ));
          } else {
            player.position.z = nextZ; // free z if no bound set
          }
        }
      }
      this.lastFrameTsByPlayer.set(player.id, now);
    }
  }

  // Collision resolution: only the local player is pushed away from remote players.
  // Remote positions are the network source of truth and are never modified locally.
  resolveCollisions() {
    const gs = this.state();
    const lid = this.localId();
    const local = lid ? gs.players[lid] : undefined;
    if (!local) return;
    const others = Object.values(gs.players).filter(p => p.id !== lid);
    for (const other of others) {
      const az = local.position.z ?? 0;
      const bz = other.position.z ?? 0;
      const dx = other.position.x - local.position.x;
      const dy = other.position.y - local.position.y;
      const dz = bz - az;
      const distSq = dx * dx + dy * dy + dz * dz;
      const minDist = this.cfg.playerRadius * 2;
      if (distSq < minDist * minDist) {
        const dist = Math.sqrt(distSq);
        const eps = 1e-6;
        const overlap = minDist - Math.max(eps, dist);
        let nx: number, ny: number, nz: number;
        if (dist < eps) {
          nx = 1; ny = 0; nz = 0;
        } else {
          nx = dx / dist; ny = dy / dist; nz = dz / dist;
        }
        local.position.x -= nx * overlap;
        local.position.y -= ny * overlap;
        local.position.z = (local.position.z ?? 0) - nz * overlap;
      }
    }
  }
}

