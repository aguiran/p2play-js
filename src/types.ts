export type SyncStrategy = "full" | "delta";
export type ConflictResolution = "timestamp" | "authoritative";
export type SerializationStrategy = "json" | "binary-min";

export interface GameLibOptions {
  maxPlayers?: number;
  syncStrategy?: SyncStrategy;
  conflictResolution?: ConflictResolution;
  authoritativeClientId?: string;
  serialization?: SerializationStrategy;
  iceServers?: RTCIceServer[]; // STUN/TURN configuration
  cleanupOnPeerLeave?: boolean; // if true and we are host: remove leaving player and broadcast state
  debug?: DebugOptions;
  backpressure?: BackpressureOptions; // send-rate control strategy
  pingOverlay?: {
    enabled?: boolean;
    position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    canvas?: HTMLCanvasElement | null;
  };
  /** Movement system configuration (interpolation/extrapolation) */
  movement?: MovementOptions;
}

export interface SendDebugInfo {
  type: "broadcast" | "send";
  to: PlayerId | "all";
  payloadBytes: number;
  delivered: number;
  queued: number;
  serialization: SerializationStrategy;
  timestamp: number;
}

export interface DebugOptions {
  enabled?: boolean;
  onSend?: (info: SendDebugInfo) => void;
}

export type BackpressureStrategy = "off" | "drop-moves" | "coalesce-moves";
export interface BackpressureOptions {
  strategy?: BackpressureStrategy;
  thresholdBytes?: number; // bufferedAmount threshold triggering the strategy (default: 262144 = 256KB)
}

export type PlayerId = string;

export interface PlayerState {
  id: PlayerId;
  position: { x: number; y: number; z?: number };
  velocity?: { x: number; y: number; z?: number };
}

export interface InventoryItem {
  id: string;
  type: string;
  quantity: number;
}

export interface InventoryState {
  [playerId: PlayerId]: InventoryItem[];
}

export interface GameObjectState {
  id: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface GlobalGameState {
  players: Record<PlayerId, PlayerState>;
  inventories: InventoryState;
  objects: Record<string, GameObjectState>;
  tick: number;
}

export interface StateDelta {
  tick: number;
  changes: Array<{
    path: string; // e.g. players.<id>.position
    value: unknown;
  }>;
}

export interface NetMessageBase {
  t: string; // message type
  ts: number; // sender timestamp
  from: PlayerId;
  seq?: number; // per-sender monotonic sequence for dedup/ordering
  ttl?: number; // optional relay budget (host fallback)
}

export interface MoveMessage extends NetMessageBase {
  t: "move";
  position: { x: number; y: number; z?: number };
  velocity?: { x: number; y: number; z?: number };
}

export interface InventoryUpdateMessage extends NetMessageBase {
  t: "inventory";
  items: InventoryItem[];
}

export interface ObjectTransferMessage extends NetMessageBase {
  t: "transfer";
  to: PlayerId;
  item: InventoryItem;
}

export interface FullStateMessage extends NetMessageBase {
  t: "state_full";
  state: GlobalGameState;
}

export interface DeltaStateMessage extends NetMessageBase {
  t: "state_delta";
  delta: StateDelta;
}

// Generic payload sharing (application-defined content)
export interface SharedPayloadMessage extends NetMessageBase {
  t: "payload";
  payload: unknown;
  channel?: string; // optional routing hint for applications
}

// Consensus-related messages intentionally omitted

export type NetMessage =
  | MoveMessage
  | InventoryUpdateMessage
  | ObjectTransferMessage
  | FullStateMessage
  | DeltaStateMessage
  | SharedPayloadMessage;

export type EventHandlerMap = {
  playerMove: (playerId: PlayerId, position: { x: number; y: number }) => void;
  inventoryUpdate: (playerId: PlayerId, inventory: InventoryItem[]) => void;
  objectTransfer: (fromPlayer: PlayerId, toPlayer: PlayerId, item: InventoryItem) => void;
  stateSync: (state: GlobalGameState) => void;
  stateDelta: (delta: StateDelta) => void;
  peerJoin: (playerId: PlayerId) => void;
  peerLeave: (playerId: PlayerId) => void;
  ping: (playerId: PlayerId, ms: number) => void;
  sharedPayload: (from: PlayerId, payload: unknown, channel?: string) => void;
  netMessage: (msg: NetMessage) => void;
  hostChange: (hostId: PlayerId) => void;
  maxCapacityReached: (maxPlayers: number) => void;
};

export type EventName = keyof EventHandlerMap;

// Movement: configuration options for smoothing and extrapolation
export interface MovementOptions {
  /** Maximum speed bound in units per second */
  maxSpeed?: number;
  /** Smoothing factor [0..1] applied each tick during interpolation */
  smoothing?: number;
  /** Max extrapolation window (ms) when an update is late */
  extrapolationMs?: number;
  /** World bounds to constrain positions (3D). depth is optional for back-compat */
  worldBounds?: { width: number; height: number; depth?: number };
  /** If true, disables all clamping against world bounds (infinite/open world) */
  ignoreWorldBounds?: boolean;
  /** Sphere radius for player-player collisions */
  playerRadius?: number;
}

