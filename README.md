## @p2play-js/p2p-game

Modular TypeScript library to build browser-based P2P (WebRTC) multiplayer games, with state synchronization and consistency strategies.

### Visual Example / Demo

[![Demo](https://raw.githubusercontent.com/aguiran/p2play-js/refs/heads/main/examples/demo-p2play-js.gif)](https://github.com/aguiran/p2play-js/tree/main/examples)

<!-- Badges -->
[![CI](https://github.com/aguiran/p2play-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aguiran/p2play-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@p2play-js/p2p-game.svg)](https://www.npmjs.com/package/@p2play-js/p2p-game)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![codecov](https://codecov.io/gh/aguiran/p2play-js/graph/badge.svg)](https://codecov.io/gh/aguiran/p2play-js)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@p2play-js/p2p-game.svg)](https://bundlephobia.com/package/@p2play-js/p2p-game)

### Installation

```bash
npm install @p2play-js/p2p-game
```

### Quick API

```ts
import { P2PGameLibrary, WebSocketSignaling } from "@p2play-js/p2p-game";

const signaling = new WebSocketSignaling("playerA", "room-42", "ws://localhost:8787");
const multiplayer = new P2PGameLibrary({
  maxPlayers: 4,
  syncStrategy: "delta",
  conflictResolution: "timestamp",
  pingOverlay: { enabled: true, position: "top-right" },
  signaling,
  // Optional:
  // serialization: 'binary-min',
  // cleanupOnPeerLeave: true,
  // backpressure: { strategy: 'coalesce-moves', thresholdBytes: 262144 },
  // debug: {
  //   enabled: true,
  //   onSend(info) {
  //     console.log('[send]', info.type, 'to', info.to, 'bytes=', info.payloadBytes, 'delivered=', info.delivered, 'queued=', info.queued);
  //   }
  // },
  // movement: {
  //   maxSpeed: 500,
  //   smoothing: 0.25,
  //   extrapolationMs: 140,
  //   worldBounds: { width: 4000, height: 3000, depth: 500 },
  //   playerRadius: 20
  // },
  // iceServers: [
  //   { urls: ['stun:stun.l.google.com:19302'] },
  //   { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' }
  // ],
});

await multiplayer.start();

multiplayer.on("playerMove", (playerId, pos) => {});
multiplayer.on("inventoryUpdate", (playerId, items) => {});
multiplayer.on("objectTransfer", (from, to, item) => {});
multiplayer.on("stateSync", (full) => {});
multiplayer.on("stateDelta", (delta) => {});
multiplayer.on("sharedPayload", (from, payload, channel) => {});

multiplayer.on("hostChange", (hostId) => {
  console.log("New host:", hostId);
});
```

#### Sending actions

```ts
multiplayer.broadcastMove("playerA", { x: 10, y: 5, z: 0 }, { x: 1, y: 0, z: 0 });

multiplayer.updateInventory("playerA", [{ id: "potion", type: "heal", quantity: 1 }]);

multiplayer.transferItem("playerA", "playerB", { id: "potion", type: "heal", quantity: 1 });

// State sync
multiplayer.broadcastFullState("playerA");

multiplayer.broadcastDelta("playerA", ["players.playerA.position"]);

// Generic payload sharing
multiplayer.broadcastPayload("playerA", { hp: 37, pos: { x: 120, y: 80 }, headYaw: 91 }, "status");
multiplayer.sendPayload("playerA", "playerB", { waypoint: { x: 500, y: 200 } }, "waypoint");

// If you want to persist some payload (e.g., HP) into shared state, mutate and broadcast a delta:
multiplayer.setStateAndBroadcast("playerA", [
  { path: "objects.playerStatus.playerA", value: { id: "playerStatus.playerA", kind: "playerStatus", data: { hp: 37 } } }
]);
```

### Implemented concepts

- WebRTC DataChannels (P2P) synchronization + WebSocket signaling (rooms)
- Global shared state: players, inventories, objects, tick
- Sync strategies: `full`, `delta`. The library accepts both message types; your app decides when to send full snapshots vs delta updates. The `syncStrategy` option is advisory and does not automatically switch internal behavior.
- Consistency strategies: `timestamp`, `authoritative`
- Event handling: movement, inventories, transfers, shared payloads
- Ping overlay: per-peer latency, simple chart

### Network and signaling

- Minimal WS server for signaling (rooms + roster + targeted routing via `to`).
- Process:
  1. `register()` → the server adds the player to the room and broadcasts the `roster` (list of `playerId`).
  2. Deterministic full‑mesh: each client initiates offers to `playerId` strictly greater than its own (avoids collisions).
  3. SDP/ICE are sent with `to=peerId` for targeted routing.
  4. DataChannels open P2P; application messages are no longer relayed.

- STUN/TURN: Google public STUN by default. For strict networks, provide a TURN server in `createRTCPeerConnection` (adapt as needed).

#### STUN vs TURN

- STUN (directory service): helps two browsers discover their public address to attempt a direct connection. Often enough at home/4G.
- TURN (relay): when direct connection fails (enterprise networks, hotels, very strict NAT), data is relayed by a server. More reliable but adds latency and uses server bandwidth.

Configure ICE servers (TURN) via options:

```ts
const multiplayer = new P2PGameLibrary({
  signaling,
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] }, // dev: convenient STUN
    {
      urls: ['turn:turn.example.com:3478?transport=udp'], // your TURN
      username: 'user',
      credential: 'pass',
    },
    // Prod (TLS) example:
    // { urls: ['turns:turn.example.com:5349?transport=tcp'], username: 'user', credential: 'pass' },
  ],
  // ... other options ...
});
await multiplayer.start();
```

Dev vs Prod note
- Dev: using a public STUN such as `stun:stun.l.google.com:19302` is convenient to get started locally. STUN only helps peers discover routes; it does not carry your game data.
- Prod: provide your own ICE servers (STUN/TURN), e.g., a managed TURN or a self‑hosted coturn, to ensure reliability on strict networks and to avoid third‑party limits.

Tip: deploy a TURN server (e.g., coturn) if your users are often behind strict networks.

### Movement: interpolation, extrapolation and collisions (2D/3D)

- `MovementSystem` applies light interpolation and capped extrapolation from `velocity`.
- 2D/3D support: positions/velocities accept an optional `z`. Use `worldBounds.depth` to constrain Z.
- Simplified collision resolution: circles (2D) or spheres (3D) with symmetric separation.

#### Movement configuration

Configure interpolation/extrapolation and collisions via the `movement` option passed to `P2PGameLibrary`.

- maxSpeed: maximum speed bound in units/second when integrating velocity.
- smoothing: smoothing factor [0..1]. Higher reduces jitter but adds visual inertia.
- extrapolationMs: max extrapolation window (ms). Limits how long we project a position when updates are late.
- worldBounds: `{ width, height, depth? }` to avoid leaving the map (Z optional).
- ignoreWorldBounds: if `true`, disables all clamping against `worldBounds` (infinite/open world). Collisions remain player-vs-player only; no boundary collisions are applied.
- playerRadius: radius used for circle/sphere collision detection/resolution.

Integration principle (per axis): `position += clamp(velocity, ±maxSpeed) * dt * smoothing`, with `dt` capped by `extrapolationMs`. Timestamps are fed on every `playerMove` to keep extrapolation consistent.

Defaults and behaviors:

- If you provide `movement.worldBounds`, it will be used for XY clamping and optionally Z if `depth > 0`.
- If you omit `movement.worldBounds`, defaults are applied: `{ width: 2000, height: 2000 }` and Z is unbounded unless `depth` is provided.
- If you set `movement.ignoreWorldBounds: true`, no coordinate clamping is applied on X/Y/Z even if `worldBounds` is present.

Example:

```ts
const multiplayer = new P2PGameLibrary({
  signaling,
  movement: {
    maxSpeed: 500,
    smoothing: 0.25,
    extrapolationMs: 140,
    worldBounds: { width: 4000, height: 3000, depth: 500 },
    // or disable bounds entirely for open worlds:
    // ignoreWorldBounds: true,
    playerRadius: 20,
  },
});
```

### Consistency modes

- timestamp (default): accept the latest received action.
- authoritative: only actions from the host (or `authoritativeClientId`) are applied.

Ordering & deduplication
- Each application message carries `seq` (per‑sender monotonic counter). Receivers ignore any `seq` ≤ last seen for that sender.
- Last‑Writer‑Wins (LWW): the “latest author” (largest `seq` for a given sender) wins. No echoes: peers never re‑broadcast application messages.

#### Authoritative mode: détails et implications

- **Source d’autorité**: par défaut, si `conflictResolution: "authoritative"` est actif et que `authoritativeClientId` n’est pas fourni, l’ID de l’hôte courant devient l’autorité. Lors d’un `hostChange`, si aucune autorité n’est explicitement définie, elle bascule automatiquement vers le nouvel hôte.
- **Application des actions**: seules les actions émanant de l’`authoritativeClientId` sont acceptées (mouvement, inventaire, transferts). Les actions des autres pairs sont ignorées par la logique interne.
- **Expérience côté client non autoritaire**:
  - Vos actions locales ne sont pas appliquées directement. Vous devez soit:
    - Relayer vos intentions à l’autorité (ex. via payload/application protocol) qui appliquera la mutation et la diffusera, ou
    - Faire de l’optimistic UI côté client, puis accepter les corrections (les deltas reçus depuis l’autorité). La lib ne fournit pas de mécanisme de reconciliation automatique; votre appli doit gérer l’UI optimiste et l’acceptation des corrections.
  - **Latence**: la latence perçue est au minimum un aller‑retour jusqu’à l’autorité (RTT) avant de voir l’état partagé mis à jour.
- **Host migration**:
  - L’hôte est élu de manière déterministe (plus petit `playerId`). Sur perte d’hôte, une ré‑élection a lieu et un `hostChange` est émis.
  - Si aucune autorité explicite n’est définie, l’autorité basculera vers le nouvel hôte automatiquement.
  - Le nouvel hôte enverra un `state_full` pour réaligner tout le monde.
- **Sécurité/anti‑triche**: ce mode reste « client‑autoritaire » (autorité = un client). Il n’est pas conçu pour être cheat‑proof. Pour un modèle réellement sécurisé, utilisez un serveur/hôte de confiance (headless) et définissez explicitement `authoritativeClientId`.
- **Bonnes pratiques**:
  - Fixer `authoritativeClientId` vers un hôte contrôlé (ex. serveur headless) pour éviter les bascules d’autorité indésirables.
  - Standardiser un protocole d’« intents » côté client non autoritaire (ex. demandes de déplacement), validées/appliquées par l’autorité, puis répercutées via `state_delta`.
  - Monitorer la latence (`ping` events) et adapter l’UI (prédiction visuelle locale, lissage) pour réduire l’impact perçu.

### Serialization / compression

- `serialization: "json" | "binary-min"`. Default: `json`.
- To enable binary:
  ```ts
  const multiplayer = new P2PGameLibrary({
    signaling,
    serialization: 'binary-min'
  });
  ```
  Current minimal binary encodes JSON to UTF‑8 (`ArrayBuffer`). Hook is ready for CBOR/Flatbuffers later.

### Rooms, full‑mesh and host migration

- Rooms: group isolation via the WS server.
- Full‑mesh: every peer establishes a direct link to all others (deterministic initiation via roster and IDs).
- Deterministic host election (smallest id) and automatic migration on host loss via `hostChange`.
- Host sends `state_full` on join/migration to realign everyone.

### WebSocket signaling

Use `WebSocketSignaling(localId, roomId, serverUrl)` to relay offers/answers/ICE via a minimal WS server.

### Examples

#### Basic WebSocket Test: `examples/basic/index.html`

A standalone WebSocket testing tool to verify connectivity with your signaling server before implementing full P2P logic.

**Purpose**:
- **Connectivity testing**: Validates that your WebSocket signaling server is accessible and working correctly
- **Network debugging**: Diagnoses connection issues (firewall, proxy, TLS certificates)
- **Protocol understanding**: Visualizes signaling message exchanges (roster, routing)
- **STUN/TURN configuration**: Tests different servers before P2P integration

**Features**:
- WebSocket connection with detailed error handling and timeout
- Automatic support for ws:// and wss:// schemes
- Interface to join rooms and announce presence
- Send arbitrary JSON messages or simple text
- WebSocket error code display with explanations
- Detailed exchange logging (timestamp, direction, content)

**Usage**:
1. Open `examples/basic/index.html` in your browser
2. Configure your server URL (default: `wss://wss.getlost.ovh`)
3. Click "Connect" to establish the WebSocket connection
4. Enter a Room ID and Player ID, then click "Join Room"
5. Send messages to test communication

**Public test server**:
- URL: `wss://wss.getlost.ovh`
- Status: Free signaling server for testing purposes only
- **Limitations**: No authentication, no persistence, best-effort service
- **Security**: Do not send sensitive data, TLS transport encryption only

#### Complete Demo: `examples/complete/index.html`

Comprehensive P2P multiplayer game demonstrating the library's core capabilities:

**Architecture showcase:**
- **State management**: Comparison of sync strategies (delta vs full)
- **Conflict resolution**: Choose between timestamp and authoritative modes (select before clicking Start)
- **Network topology**: Full-mesh P2P with deterministic host election
- **Movement system**: Interpolation, extrapolation, and collision detection in action

**Advanced features:**
- **Resilience**: Automatic host migration when players disconnect
- **Performance**: State delta updates and basic backpressure handling
- **Debugging**: Real-time event logging and network diagnostics
- **Scalability**: Multi-player synchronization; configurable player limits

See the "Local dev servers" section below for setup and usage instructions. In the demo UI, pick the strategy and mode, then click Start.

### Events

| Event            | Signature                                          | Description              |
|------------------|----------------------------------------------------|--------------------------|
| playerMove       | (playerId, position)                               | Movement applied         |
| inventoryUpdate  | (playerId, items)                                  | Inventory updated        |
| objectTransfer   | (from, to, item)                                   | Object transferred       |
| sharedPayload    | (from, payload, channel?)                           | Generic payload received |
| stateSync        | (state)                                            | Full snapshot received   |
| stateDelta       | (delta)                                            | State delta received     |
| peerJoin         | (playerId)                                         | Peer connected           |
| peerLeave        | (playerId)                                         | Peer disconnected        |
| hostChange       | (hostId)                                           | New host                 |
| ping             | (playerId, ms)                                     | RTT to peer              |
| maxCapacityReached | (maxPlayers)                                     | Capacity reached; new connections refused |

### Lifecycle & presence

- Presence: `announcePresence(playerId)` is recommended to emit an initial move so peers render the player immediately.
- `peerJoin`/`peerLeave`: the UI can show/hide entities. Host‑side cleanup can be automated by enabling `cleanupOnPeerLeave: true` in `P2PGameLibrary` options: the host removes the leaving player's entries and broadcasts a delta accordingly.
- `peerJoin`/`peerLeave`: the UI can show/hide entities. Host‑side cleanup can be automated by enabling `cleanupOnPeerLeave: true` in `P2PGameLibrary` options: the host removes the leaving player's entries and broadcasts a delta accordingly.
- Capacity limit: set `maxPlayers` to cap the room size. When capacity is reached, the library will not initiate new connections and will ignore incoming offers; it emits `maxCapacityReached(maxPlayers)` so you can inform the user/UI.

### Performance & best practices

- Prefer deltas, use occasional full snapshots (join/migration, catch‑up): practically “hybrid”.
- Limit update frequency (tick) and consider batching deltas.
- Monitor `RTCDataChannel.bufferedAmount` to avoid bursts saturating the channel.

### Shared payloads

- `broadcastPayload(playerId, payload, channel?)` sends an arbitrary object to all peers.
- `sendPayload(playerId, to, payload, channel?)` sends an arbitrary object to a single peer.
- `sharedPayload` is emitted on receipt: `(from, payload, channel?)`.
- No schema constraints; your app should type/validate the payload.
- Do not send secrets; payload is visible to the recipients.

#### Making a payload persistent (e.g., HP)

- Payloads are ephemeral by default (not included in `state_full`/`state_delta`).
- If you want persistence (e.g., hit points), store it in your own state schema (e.g., `objects`) and broadcast a delta:

```ts
// Host-only if you apply an authoritative model
multiplayer.on("sharedPayload", (from, payload, channel) => {
  if (channel === "status" && payload && typeof payload === "object" && "hp" in (payload as any)) {
    // Write into global state
    multiplayer.setStateAndBroadcast(multiplayer.getHostId()!, [
      { path: `objects.playerStatus.${from}`, value: { id: `playerStatus.${from}`, kind: "playerStatus", data: { hp: (payload as any).hp } } }
    ]);
  }
});
```

Notes:
- The schema under `objects.*` is application-defined.
- In `authoritative` mode, apply mutations on the host only.

### Useful scripts

- `npm run serve:ws` starts the signaling WS server (port 8787).
- `npm run serve:http` serves `/examples` and `/dist` (port 8080).
- `npm run prepublishOnly` cleans and rebuilds before publishing.


### Local dev servers: http-server and ws-server

This repo ships two tiny servers to run the demo locally:

- `examples/server/ws-server.mjs` (WebSocket signaling)
  - Purpose: WebRTC peers need an out-of-band channel to exchange SDP offers/answers and ICE candidates before the P2P DataChannel can open.
  - What it does: room join/leave, roster broadcast, and targeted relay of signaling messages using a `to` field.
  - Port: `8787` by default. You can override with `PORT=9000 node examples/server/ws-server.mjs`.
  - Dev-only: in production, deploy your own HTTPS/WSS signaling (e.g., behind a reverse proxy) and configure TURN.

- `examples/server/http-server.cjs` (static HTTP)
  - Purpose: serve the demo UI (`/examples`) and the built library (`/dist`) locally.
  - Port: `8080` (fixed, simple dev server).
  - Dev-only: your real app will be served by your own web server or bundler.

How to run the demo locally
1. Build the library once: `npm run build`
2. Start signaling: `npm run serve:ws` (listens on ws://localhost:8787)
3. In another terminal, start HTTP: `npm run serve:http` (serves http://localhost:8080)
4. Open `http://localhost:8080/examples/complete/index.html`
5. In two browser tabs:
   - Choose the same room, different Player IDs
   - Click Start in both tabs
   - Move with arrows/WASD; transfer a potion; observe host and ping overlay

Notes
- The demo uses a public STUN (Google) by default for convenience in dev. For production, provide your own ICE (STUN/TURN) and secure signaling over WSS.
- If you change signaling port/host, update the `WebSocketSignaling(..., serverUrl)` in the demo accordingly.


Notes
- Signaling: targeted (field `to`) via WS; `roster` is broadcast on each join/leave.
- Full‑mesh: each peer establishes a DataChannel with all others (initiation: smaller id → larger id).
- Host: deterministically elected; sends `state_full` on join and on migration.
- Conflicts: LWW by `seq` (per sender) or `authoritative` (host).
- Sync: frequent deltas, occasional full (hybrid = combined usage).

### License

MIT

---
