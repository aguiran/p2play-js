import { WebSocketServer } from 'ws';
import { createHmac } from 'crypto';

/**
 * Reference WebSocket signaling server (rooms, roster, targeted relay).
 *
 * Optional security (env, all off by default):
 * - ENFORCE_SESSION_IDENTITY=1: overwrite msg.from with session identity when relaying.
 * - REQUIRE_ROOM_TOKEN=1: require valid JWT at register (ROOM_TOKEN_SECRET must be set).
 *   If the JWT contains a roomId claim, it must match the message's roomId or the register is rejected.
 * - STRICT_ENVELOPES=1: reject invalid message shape.
 *
 * Envelope schema (when STRICT_ENVELOPES=1):
 * - Required: roomId (string), kind in ['register', 'desc', 'ice'].
 * - Register: also require announce, from.
 * - Processing order: 1) validate envelope, 2) identity/register, 3) token if REQUIRE_ROOM_TOKEN.
 */

const port = process.env.PORT || 8787;
const debugLogs = process.env.DEBUG_LOGS === '1';
const enforceSessionIdentity = process.env.ENFORCE_SESSION_IDENTITY === '1';
const strictEnvelopes = process.env.STRICT_ENVELOPES === '1';
const requireRoomToken = process.env.REQUIRE_ROOM_TOKEN === '1';
const roomTokenSecret = process.env.ROOM_TOKEN_SECRET || '';
const ALLOWED_KINDS = ['register', 'desc', 'ice'];
const wss = new WebSocketServer({ port });

if (requireRoomToken && !roomTokenSecret) {
  console.error('REQUIRE_ROOM_TOKEN=1 requires ROOM_TOKEN_SECRET to be set. Exiting.');
  process.exit(1);
}

// Map roomId -> { sockets: Set(ws), roster: Set<string> }
const rooms = new Map();
// Track per-connection metadata
const wsInfo = new WeakMap(); // ws -> { id: number, rooms: Set<string>, playerId?: string }
let clientCounter = 0;

function sendErrorAndClose(ws, code) {
  try {
    ws.send(JSON.stringify({ sys: 'error', code }));
  } catch (_) {}
  ws.close();
}

function validateEnvelope(msg, isRegister) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.roomId !== 'string' || !msg.roomId) return false;
  if (typeof msg.kind !== 'string' || !ALLOWED_KINDS.includes(msg.kind)) return false;
  if (isRegister && msg.kind === 'register') {
    if (msg.announce === undefined || msg.announce === null) return false;
    if (typeof msg.from !== 'string') return false;
  }
  return true;
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) rooms.set(roomId, (room = { sockets: new Set(), roster: new Set() }));
  return room;
}

function logRoomsSummary() {
  const summary = [...rooms.entries()].map(([rid, room]) => `${rid}(${room.sockets.size})`).join(', ') || 'none';
  console.log(`[rooms] ${summary}`);
}

/** Verify HS256 JWT; returns payload (with sub, roomId, exp) or null. */
function verifyRoomToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [headerB64, payloadB64, sigB64] = parts;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const toSign = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac('sha256', secret).update(toSign).digest('base64url');
    if (expectedSig !== sigB64) return null;
    if (payload.exp != null && Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

wss.on('connection', (ws, req) => {
  const id = ++clientCounter;
  wsInfo.set(ws, { id, rooms: new Set() });
  console.log(`[conn#${id}] open from ${req?.socket?.remoteAddress || 'unknown'}`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.warn(`[conn#${id}] invalid JSON, message ignored (${data.toString().slice(0, 120)}...)`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const { roomId, kind, from, to, announce } = msg;
    if (strictEnvelopes) {
      const room = roomId ? (rooms.get(roomId) ?? null) : null;
      const isRegister = room ? !room.sockets.has(ws) : true;
      if (!validateEnvelope(msg, isRegister)) {
        sendErrorAndClose(ws, 'invalid_envelope');
        return;
      }
    } else if (!roomId) {
      console.warn(`[conn#${id}] message ignored: missing roomId`);
      return;
    }
    if (!roomId) return;
    const room = getRoom(roomId);
    const isRegister = !room.sockets.has(ws);
    if (!room.sockets.has(ws)) {
      if (requireRoomToken) {
        const token = msg.roomToken;
        if (!token || typeof token !== 'string') {
          sendErrorAndClose(ws, 'auth_required');
          return;
        }
        const payload = verifyRoomToken(token, roomTokenSecret);
        if (!payload) {
          sendErrorAndClose(ws, 'auth_required');
          return;
        }
        if (payload.roomId != null && payload.roomId !== '' && String(payload.roomId) !== String(roomId)) {
          sendErrorAndClose(ws, 'auth_required');
          return;
        }
        const sessionPlayerId = (enforceSessionIdentity && typeof payload.sub === 'string' && payload.sub) ? payload.sub : from;
        room.sockets.add(ws);
        wsInfo.get(ws).rooms.add(roomId);
        wsInfo.get(ws).playerId = sessionPlayerId;
        if (announce && sessionPlayerId) {
          room.roster.add(sessionPlayerId);
          const rosterMsg = { sys: 'roster', roomId, roster: [...room.roster] };
          for (const peer of room.sockets) if (peer.readyState === ws.OPEN) peer.send(JSON.stringify(rosterMsg));
        }
      } else {
        room.sockets.add(ws);
        wsInfo.get(ws).rooms.add(roomId);
        if (announce && from) {
          wsInfo.get(ws).playerId = from;
          room.roster.add(from);
          const rosterMsg = { sys: 'roster', roomId, roster: [...room.roster] };
          for (const peer of room.sockets) if (peer.readyState === ws.OPEN) peer.send(JSON.stringify(rosterMsg));
        }
      }
      console.log(`[conn#${id}] joined room '${roomId}'`);
      logRoomsSummary();
    }
    const payloadSize = Buffer.byteLength(JSON.stringify(msg));
    let delivered = 0;
    const senderPlayerId = enforceSessionIdentity ? wsInfo.get(ws)?.playerId : undefined;
    const relayMsg = (targetMsg) => {
      const out = senderPlayerId != null ? { ...targetMsg, from: senderPlayerId } : targetMsg;
      return JSON.stringify(out);
    };
    // Targeted delivery if 'to' provided, else broadcast to room (excluding sender)
    if (to) {
      for (const peer of room.sockets) {
        const info = wsInfo.get(peer);
        if (peer !== ws && info?.playerId === to && peer.readyState === ws.OPEN) {
          peer.send(relayMsg(msg));
          delivered++;
        }
      }
    } else {
      for (const peer of room.sockets) {
        if (peer !== ws && peer.readyState === ws.OPEN) {
          peer.send(relayMsg(msg));
          delivered++;
        }
      }
    }
    if (debugLogs) {
      console.log(`[room:${roomId}] kind=${kind || 'data'} from=${from} to=${to || 'all'} delivered=${delivered} size=${payloadSize}B`);
    }
  });

  ws.on('close', () => {
    const info = wsInfo.get(ws);
    if (info) {
      for (const rid of info.rooms) {
        const room = rooms.get(rid);
        if (room) {
          room.sockets.delete(ws);
          if (info.playerId) room.roster.delete(info.playerId);
          if (room.sockets.size === 0) {
            rooms.delete(rid);
            console.log(`[rooms] '${rid}' is now empty and removed`);
          } else {
            // broadcast roster update
            const rosterMsg = { sys: 'roster', roomId: rid, roster: [...room.roster] };
            for (const peer of room.sockets) if (peer.readyState === ws.OPEN) peer.send(JSON.stringify(rosterMsg));
          }
        }
      }
    }
    console.log(`[conn#${id}] close`);
    logRoomsSummary();
  });
});

console.log(`WS signaling server listening on ws://localhost:${port}`);

