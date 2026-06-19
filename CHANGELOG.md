# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-06-19

### Added
- `P2PGameLibrary.voice` API: selective peer audio (`talk` bidirectional, `listen` one-way) via SDP renegotiation on the existing `RTCPeerConnection`s. No signaling protocol changes: renegotiation reuses the existing `desc`/`ice` envelopes, so custom `SignalingAdapter` implementations and the reference WS server work unchanged.
- Voice methods: `voice.start(peerId, { mode, localStream? })`, `voice.stop(peerId)`, `voice.stopAll()`, `voice.setMuted(muted)`, `voice.isMuted()`, `voice.getActiveLinks()`.
- Voice events (dedicated emitter): `remoteStream`, `remoteStreamRemoved`, `state` (`connecting`/`connected`/`disconnected`/`failed`), `error`.
- Remote auto-answer: only the caller of `voice.start()` initiates; the remote library handles the incoming renegotiation (attaching its microphone when the link requests it — the browser permission prompt is the consent gate; on denial the negotiation completes without audio and `error` is emitted).
- Shared microphone lifecycle: one `MediaStreamTrack` reused across all peer connections; the library-owned mic track is stopped once no link sends audio anymore. App-provided `localStream`s are never stopped by the library.
- `PeerManager.renegotiate(peerId)` and `setMediaNegotiationHooks(...)`: explicit, serialized SDP renegotiation on connected peers with glare handling (perfect negotiation; politeness derived from the same deterministic id order as host election).
- New types: `VoiceMode`, `VoiceState`, `VoiceOptions`, `VoiceEventHandlerMap`.
- Example: `examples/voice/index.html` (per-peer Talk/Listen/Stop, global mute, remote audio playback, 3-tab listen scenario).

### Changed
- `PeerManager` accepts renegotiation offers from already-connected peers (previously ignored) without tearing down DataChannels; audio transceivers are reused across `start`/`stop` cycles (`direction: "inactive"`, no m-line growth). Renegotiation offers from existing peers bypass the room capacity check.
- `broadcastMove`, `announcePresence` and the `playerMove` event now expose the optional `z` axis in their TypeScript signatures, matching `MoveMessage` / `PlayerState`. No runtime change: the third axis already flowed through at runtime but was not typed on the public surface.

### Fixed
- `EventBus` isolates listener exceptions: a throwing application listener no longer breaks internal message routing nor prevents the remaining listeners from running (the error is reported via `console.error`).
- Remote ICE candidates that fail to apply (e.g. stale candidates after a renegotiation rollback) are now swallowed instead of surfacing as unhandled promise rejections.
- `WebSocketSignaling` no longer fires the `onDisconnect` callback twice when a socket failure emits both `error` and `close`; the guard resets on a successful reconnect.

### Security
- Hardened internal path-based state updates (`state_delta`, `setStateAndBroadcast`) against prototype pollution: path segments `__proto__`, `prototype` and `constructor` are rejected, so a malicious peer can no longer reach `Object.prototype` through a crafted delta path.

### Migration
- No breaking changes. `SignalingAdapter` and the WS server protocol are unchanged; existing apps and custom adapters keep working as-is. Voice is opt-in via `multiplayer.voice`.

## [0.2.1] - 2026-05-15

### Fixed
- `setStateAndBroadcast`, `broadcastDelta` and `broadcastFullState` emit `stateDelta` / `stateSync` locally for the sender (previously only receiving peers got the event).
- `updateInventory` and `transferItem` apply the mutation to the local `StateManager` (via the conflict resolver) and emit `inventoryUpdate` / `objectTransfer` locally before broadcasting. Previously only remote peers' states were updated, leaving the sender's `getState().inventories[selfId]` stale.
- `broadcastMove` and `announcePresence` go through the same local-apply path, so the sender receives a `playerMove` event. `announcePresence` now includes a per-sender `seq` for ordering.
- `broadcastPayload` emits `sharedPayload` locally for the sender.
- Host inserts the joining peer into `state.players` in the `peerJoin` handler and emits `stateDelta` locally. Previously the host relied on the joiner's `announcePresence`, leaving the host's UI (player count, lobby roster, etc.) stuck at N-1 until the first move from the joiner reached the host. The host does not re-broadcast `players.<peerId>` to other peers: `<peerId>` is the sender-owned authority for that path, and a snapshot at `{0,0}` would race with the joiner's `announcePresence` on the unreliable channel (the joiner's own broadcast is the source of truth for its position on all peers).
- `sendPayload(selfId, selfId, payload, channel)` emits `sharedPayload` locally instead of silently dropping (there is no `DataChannel` to self).

### Migration
- No public API changes. Workarounds that re-emit events manually or call `setStateAndBroadcast` after every mutation can be removed.
- `stateDelta`, `stateSync`, `playerMove`, `inventoryUpdate`, `objectTransfer` and `sharedPayload` now fire on the sender too. Code that re-applied changes inside these listeners (e.g. mutating state in response to its own `playerMove`) must guard against the new local emission.

## [0.2.0] - 2026-05-13

> Note: in semver `0.x`, minor bumps can include breaking changes.

### Added
- `PeerTimingOptions` (`pendingOfferTimeoutMs`, `pingIntervalMs`).
- `WebSocketSignaling.onError(code)` callback and `reconnectOptions`.
- Signaling server JWT `roomId` claim validation.
- Centralized defaults in `src/defaults.ts`.
- Shared path helpers in `src/sync/pathUtils.ts`.
- Guard against duplicate `peerJoin` emission when `onconnectionstatechange` re-fires `connected`.

### Changed (Breaking)
- `ConflictResolution` now supports only `"timestamp"`.
- `MovementSystem.resolveCollisions()` now pushes only the local player; remote positions are never mutated locally.
- Network guard now requires `transfer.item.type` to be a string.
- `StateManager` constructor signature changed (removed authority-related callbacks).

### Fixed
- Timers now use global `setInterval` / `clearInterval` instead of `window.*`.
- Verbose console output in `PeerManager` is gated behind `debug.enabled`.

### Removed
- `GameLibOptions.authoritativeClientId`.
- `evolution.md`.

### Migration
- Replace `conflictResolution: "authoritative"` with `conflictResolution: "timestamp"`.
- Remove any usage of `authoritativeClientId`.
- If your app relied on host-only writes, enforce that policy in your application layer.
- Re-deploy any public demos consuming this package version after publish.
