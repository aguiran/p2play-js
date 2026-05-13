# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
