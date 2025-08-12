import { WebSocketServer } from 'ws';

const port = process.env.PORT || 8787;
const wss = new WebSocketServer({ port });

// Map roomId -> { sockets: Set(ws), roster: Set<string> }
const rooms = new Map();
// Track per-connection metadata
const wsInfo = new WeakMap(); // ws -> { id: number, rooms: Set<string>, playerId?: string }
let clientCounter = 0;

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) rooms.set(roomId, (room = { sockets: new Set(), roster: new Set() }));
  return room;
}

function logRoomsSummary() {
  const summary = [...rooms.entries()].map(([rid, set]) => `${rid}(${set.size})`).join(', ') || 'none';
  console.log(`[rooms] ${summary}`);
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
      console.warn(`[conn#${id}] invalid JSON (${data.toString().slice(0, 120)}...)`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const { roomId, kind, from, to, announce } = msg;
    if (!roomId) {
      console.warn(`[conn#${id}] message without roomId ignored`);
      return;
    }
    const room = getRoom(roomId);
    if (!room.sockets.has(ws)) {
      room.sockets.add(ws);
      wsInfo.get(ws).rooms.add(roomId);
      // register player if announced
      if (announce && from) {
        wsInfo.get(ws).playerId = from;
        room.roster.add(from);
        // broadcast roster update
        const rosterMsg = { sys: 'roster', roomId, roster: [...room.roster] };
        for (const peer of room.sockets) if (peer.readyState === ws.OPEN) peer.send(JSON.stringify(rosterMsg));
      }
      console.log(`[conn#${id}] joined room '${roomId}'`);
      logRoomsSummary();
    }
    const payloadSize = Buffer.byteLength(JSON.stringify(msg));
    let delivered = 0;
    // Targeted delivery if 'to' provided, else broadcast to room (excluding sender)
    if (to) {
      for (const peer of room.sockets) {
        const info = wsInfo.get(peer);
        if (peer !== ws && info?.playerId === to && peer.readyState === ws.OPEN) {
          peer.send(JSON.stringify(msg));
          delivered++;
        }
      }
    } else {
      for (const peer of room.sockets) {
        if (peer !== ws && peer.readyState === ws.OPEN) {
          peer.send(JSON.stringify(msg));
          delivered++;
        }
      }
    }
    console.log(`[room:${roomId}] kind=${kind || 'data'} from=${from} to=${to || 'all'} delivered=${delivered} size=${payloadSize}B`);
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

