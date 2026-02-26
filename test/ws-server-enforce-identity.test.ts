import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createHmac } from 'crypto';

const TEST_PORT = 18787;
const STRICT_PORT = 18788;

function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

describe('ws-server ENFORCE_SESSION_IDENTITY', () => {
  let serverProcess: ReturnType<typeof spawn>;

  beforeAll(async () => {
    serverProcess = spawn('node', ['examples/server/ws-server.mjs'], {
      env: { ...process.env, ENFORCE_SESSION_IDENTITY: '1', PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 500);
      serverProcess.stdout?.on('data', () => {
        clearTimeout(t);
        resolve();
      });
      serverProcess.stderr?.on('data', () => {});
      serverProcess.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('overwrites from with session identity when relaying (no spoofing)', async () => {
    const url = `ws://localhost:${TEST_PORT}`;
    const roomId = 'enforce-test-' + Date.now();

    const client1 = new WebSocket(url);
    const client2 = new WebSocket(url);

    await Promise.all([
      new Promise<void>((res) => client1.on('open', () => res())),
      new Promise<void>((res) => client2.on('open', () => res())),
    ]);

    const receivedBy2: Array<{ from?: string; kind?: string }> = [];
    client2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.sys === 'roster') return;
      receivedBy2.push({ from: msg.from, kind: msg.kind });
    });

    client1.send(JSON.stringify({ roomId, from: 'Alice', announce: true, kind: 'register' }));
    client2.send(JSON.stringify({ roomId, from: 'Bob', announce: true, kind: 'register' }));

    await new Promise((r) => setTimeout(r, 150));

    client1.send(JSON.stringify({
      roomId,
      from: 'Mallory',
      kind: 'desc',
      payload: { type: 'offer', sdp: 'fake' },
    }));

    await new Promise((r) => setTimeout(r, 150));

    const descMsg = receivedBy2.find((m) => m.kind === 'desc');
    expect(descMsg).toBeDefined();
    expect(descMsg?.from).toBe('Alice');

    client1.close();
    client2.close();
  });
});

describe('ws-server STRICT_ENVELOPES', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const STRICT_PORT = 18788;

  beforeAll(async () => {
    serverProcess = spawn('node', ['examples/server/ws-server.mjs'], {
      env: { ...process.env, STRICT_ENVELOPES: '1', PORT: String(STRICT_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve) => {
      serverProcess.stdout?.on('data', () => resolve());
      serverProcess.stderr?.on('data', () => {});
      setTimeout(() => resolve(), 500);
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('rejects message without roomId and closes with invalid_envelope', async () => {
    const url = `ws://localhost:${STRICT_PORT}`;
    const client = new WebSocket(url);
    const received: Array<{ sys?: string; code?: string }> = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({ from: 'A', kind: 'desc', payload: {} }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received.some((m) => m.sys === 'error' && m.code === 'invalid_envelope')).toBe(true);
    client.close();
  });

  it('rejects message with unknown kind and closes with invalid_envelope', async () => {
    const url = `ws://localhost:${STRICT_PORT}`;
    const client = new WebSocket(url);
    const received: Array<{ sys?: string; code?: string }> = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({ roomId: 'r1', from: 'A', kind: 'unknown' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received.some((m) => m.sys === 'error' && m.code === 'invalid_envelope')).toBe(true);
    client.close();
  });

  it('accepts valid register and rejects invalid relay', async () => {
    const url = `ws://localhost:${STRICT_PORT}`;
    const roomId = 'strict-' + Date.now();
    const client = new WebSocket(url);
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({ roomId, from: 'P1', announce: true, kind: 'register' }));
    await new Promise((r) => setTimeout(r, 100));
    const roster = received.find((m) => m.sys === 'roster');
    expect(roster).toBeDefined();
    expect(roster?.roster).toContain('P1');
    received.length = 0;
    client.send(JSON.stringify({ roomId, payload: {} }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received.some((m) => m.sys === 'error' && m.code === 'invalid_envelope')).toBe(true);
    client.close();
  });
});

describe('ws-server REQUIRE_ROOM_TOKEN', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const TOKEN_PORT = 18789;
  const SECRET = 'test-secret';

  it('exits when REQUIRE_ROOM_TOKEN=1 and ROOM_TOKEN_SECRET is not set', async () => {
    const child = spawn('node', ['examples/server/ws-server.mjs'], {
      env: { ...process.env, REQUIRE_ROOM_TOKEN: '1', PORT: '18791' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code ?? null));
      setTimeout(() => resolve(-1), 2000);
    });
    expect(exitCode).toBe(1);
  });

  beforeAll(async () => {
    serverProcess = spawn('node', ['examples/server/ws-server.mjs'], {
      env: { ...process.env, REQUIRE_ROOM_TOKEN: '1', ROOM_TOKEN_SECRET: SECRET, PORT: String(TOKEN_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve) => {
      serverProcess.stdout?.on('data', () => resolve());
      serverProcess.stderr?.on('data', () => {});
      setTimeout(() => resolve(), 500);
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('rejects register without roomToken with auth_required and closes', async () => {
    const url = `ws://localhost:${TOKEN_PORT}`;
    const roomId = 'token-' + Date.now();
    const client = new WebSocket(url);
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({ roomId, from: 'P1', announce: true, kind: 'register' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received.some((m) => m.sys === 'error' && m.code === 'auth_required')).toBe(true);
    client.close();
  });

  it('rejects register with invalid token with auth_required', async () => {
    const url = `ws://localhost:${TOKEN_PORT}`;
    const roomId = 'token-' + Date.now();
    const client = new WebSocket(url);
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({
      roomId,
      from: 'P1',
      announce: true,
      kind: 'register',
      roomToken: 'invalid.jwt.here',
    }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received.some((m) => m.sys === 'error' && m.code === 'auth_required')).toBe(true);
    client.close();
  });

  it('accepts register with valid JWT and roster contains player', async () => {
    const url = `ws://localhost:${TOKEN_PORT}`;
    const roomId = 'token-' + Date.now();
    const token = signJWT({ sub: 'Alice', roomId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const client = new WebSocket(url);
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((res) => client.on('open', () => res()));
    client.send(JSON.stringify({
      roomId,
      from: 'Alice',
      announce: true,
      kind: 'register',
      roomToken: token,
    }));
    await new Promise((r) => setTimeout(r, 150));
    const roster = received.find((m) => m.sys === 'roster');
    expect(roster).toBeDefined();
    expect(roster?.roster).toContain('Alice');
    client.close();
  });
});

describe('ws-server REQUIRE_ROOM_TOKEN + ENFORCE_SESSION_IDENTITY', () => {
  let serverProcess: ReturnType<typeof spawn>;
  const TOKEN_ENFORCE_PORT = 18790;
  const SECRET = 'test-secret';

  beforeAll(async () => {
    serverProcess = spawn('node', ['examples/server/ws-server.mjs'], {
      env: {
        ...process.env,
        REQUIRE_ROOM_TOKEN: '1',
        ROOM_TOKEN_SECRET: SECRET,
        ENFORCE_SESSION_IDENTITY: '1',
        PORT: String(TOKEN_ENFORCE_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve) => {
      serverProcess.stdout?.on('data', () => resolve());
      serverProcess.stderr?.on('data', () => {});
      setTimeout(() => resolve(), 500);
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('relay uses sub from token not from payload', async () => {
    const url = `ws://localhost:${TOKEN_ENFORCE_PORT}`;
    const roomId = 'token-identity-' + Date.now();
    const token = signJWT({ sub: 'Alice', roomId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const token2 = signJWT({ sub: 'Bob', roomId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const client1 = new WebSocket(url);
    const client2 = new WebSocket(url);
    await Promise.all([
      new Promise<void>((res) => client1.on('open', () => res())),
      new Promise<void>((res) => client2.on('open', () => res())),
    ]);
    client1.send(JSON.stringify({ roomId, from: 'Spoofed', announce: true, kind: 'register', roomToken: token }));
    client2.send(JSON.stringify({ roomId, from: 'Bob', announce: true, kind: 'register', roomToken: token2 }));
    await new Promise((r) => setTimeout(r, 150));
    const receivedBy2: Array<{ from?: string; kind?: string }> = [];
    client2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.sys === 'roster') return;
      receivedBy2.push({ from: msg.from, kind: msg.kind });
    });
    client1.send(JSON.stringify({
      roomId,
      from: 'Spoofed',
      kind: 'desc',
      payload: { type: 'offer', sdp: 'x' },
    }));
    await new Promise((r) => setTimeout(r, 150));
    const descMsg = receivedBy2.find((m) => m.kind === 'desc');
    expect(descMsg?.from).toBe('Alice');
    client1.close();
    client2.close();
  });
});
