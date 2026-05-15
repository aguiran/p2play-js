# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
