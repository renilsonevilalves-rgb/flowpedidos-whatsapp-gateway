const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual prebuild output without opening a real WhatsApp socket.
const source = readFileSync(join(__dirname, '../src/server.ts'), 'utf8');
const names = ['getOrCreateSession', 'authPathFor', 'clearAuthState', 'scheduleReconnect',
  'getPublicSessionState', 'connectSession', 'startSessionWithRecovery', 'logoutSession', 'restorePersistedSessions'];
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, names.length);
const code = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ registered = false, saveGates = [] } = {}) {
  const sockets = [], reads = [], timers = new Map(), logs = [], writes = [], deleted = [];
  const disk = new Map();
  let saves = 0;
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (_data, message) => logs.push(message)]));
  logger.child = () => logger;
  const context = vm.createContext({
    sessions: new Map(), manualLogouts: new Set(), shuttingDown: false, logger, baileysLogger: logger,
    DATA_DIR: '/data/whatsapp-sessions', join,
    DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440, restartRequired: 515 },
    Browsers: { ubuntu: () => ['test'] },
    QRCode: { toDataURL: async () => 'test-qr' },
    handleIncomingMessages: async () => {},
    resolveWhatsAppWebVersion: async () => undefined,
    waitForQrOrConnected: async id => context.sessions.get(id).status,
    setTimeout: callback => { const token = {}; timers.set(token, callback); return token; },
    clearTimeout: token => timers.delete(token),
    rm: async path => { deleted.push(path); disk.delete(path); },
    readdir: async () => [...disk.keys()].map(path => ({ isDirectory: () => true, name: path.split('/').pop() })),
    safeSessionId: value => /^[a-zA-Z0-9_-]{1,80}$/.test(value),
    readFile: async path => JSON.stringify(disk.get(path.replace(/\/creds.json$/, ''))),
    useMultiFileAuthState: async path => {
      reads.push(path);
      const state = { creds: { ...(disk.get(path) || { registered }) } };
      return { state, saveCreds: async () => {
        const number = saves++;
        await saveGates[number]?.promise;
        const snapshot = { ...state.creds };
        disk.set(path, snapshot);
        writes.push(snapshot);
      } };
    },
    makeWASocket: options => {
      const ev = new EventEmitter();
      const sock = { ev, auth: options.auth, ended: false, user: { id: 'test:1' },
        end() { this.ended = true; }, async logout() { this.ended = true; } };
      sockets.push(sock);
      return sock;
    },
  });
  vm.runInContext(code, context);
  return { context, sockets, reads, disk, timers, logs, writes, deleted,
    session: () => context.sessions.get('tenant'),
    start: () => context.startSessionWithRecovery('tenant'),
    update(sock, values) { Object.assign(sock.auth.creds, values); sock.ev.emit('creds.update', values); },
    async event(sock, update) { await Promise.all(sock.ev.listeners('connection.update').map(listener => listener(update))); },
    async close(sock, statusCode) { await this.event(sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } }); },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await flush(); },
  };
}

test('515 restarts once with saved credentials even when registered is false', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ saveGates: [first, second] });
  await h.start();
  const old = h.sockets[0];
  h.update(old, { pairing: 'first' });
  h.update(old, { pairing: 'final' });
  await h.close(old, 515);
  await h.close(old, 515);
  assert.equal(h.timers.size, 1);
  assert.equal(h.session().status, 'starting');
  await h.tick();
  const starts = Array.from({ length: 20 }, () => h.start());
  await flush();
  assert.equal(h.reads.length, 1, 'must not reload auth while writes are pending');
  first.resolve();
  await flush();
  assert.equal(h.sockets.length, 1);
  second.resolve();
  await Promise.all(starts);
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].auth.creds.pairing, 'final');
  assert.equal(h.sockets[1].auth.creds.registered, false);
  assert.equal(h.reads[0], h.reads[1]);
  assert.equal(h.deleted.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(old.ended, true);
  assert.equal(old.ev.listenerCount('creds.update'), 0);
  assert.equal(h.logs.some(line => line.startsWith('Unregistered WhatsApp session closed')), false);
  await h.event(h.sockets[1], { connection: 'open' });
  assert.equal(h.session().status, 'connected');
  assert.ok(h.logs.includes('WhatsApp connected after pairing restart'));
  await Promise.all(Array.from({ length: 20 }, () => h.start()));
  assert.equal(h.sockets.length, 2);
});

test('/start replaces a pending 515 timer without creating two sockets', async () => {
  const h = harness();
  await h.start();
  h.context.scheduleReconnect('tenant');
  const previousTimer = h.session().reconnectTimer;
  await h.close(h.sockets[0], 515);
  assert.equal(h.timers.has(previousTimer), false);
  assert.equal(h.timers.size, 1);
  await Promise.all([h.start(), h.start(), h.start()]);
  await h.tick();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.deleted.length, 0);
});

test('simultaneous initial starts and QR polling retain one live socket', async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 20 }, () => h.start()));
  await h.event(h.sockets[0], { qr: 'synthetic' });
  await Promise.all(Array.from({ length: 20 }, () => h.start()));
  assert.equal(h.sockets.length, 1);
  assert.equal(h.session().status, 'qr');
});

test('stale socket close and credential events cannot affect its replacement', async () => {
  const h = harness();
  await h.start();
  const old = h.sockets[0];
  await h.close(old, 515);
  await h.tick();
  const active = h.sockets[1];
  await h.event(active, { connection: 'open' });
  await h.close(old, 401);
  h.update(old, { stale: true });
  await flush();
  assert.equal(h.session().sock, active);
  assert.equal(h.session().status, 'connected');
  assert.equal(h.deleted.length, 0);
  assert.equal(h.writes.length, 0);
});

test('real 401 waits for writes, removes auth and never schedules reconnect', async () => {
  const gate = deferred();
  const h = harness({ saveGates: [gate] });
  await h.start();
  h.update(h.sockets[0], { registered: true });
  h.context.scheduleReconnect('tenant');
  const closing = h.close(h.sockets[0], 401);
  const starting = h.start();
  await flush();
  assert.equal(h.session().status, 'logged_out');
  assert.equal(h.deleted.length, 0);
  assert.equal(h.reads.length, 1);
  gate.resolve();
  await Promise.all([closing, starting]);
  assert.equal(h.deleted.length, 1);
  assert.equal(h.disk.size, 0);
  assert.equal(h.timers.size, 0);
  await h.start();
  assert.equal(h.sockets.length, 2, 'explicit pairing remains possible after real logout');
});

test('manual logout cancels a 515 restart waiting for persistence', async () => {
  const gate = deferred();
  const h = harness({ saveGates: [gate] });
  await h.start();
  h.update(h.sockets[0], { pairing: 'saved' });
  await h.close(h.sockets[0], 515);
  await h.tick();
  const logout = h.context.logoutSession('tenant');
  await flush();
  gate.resolve();
  await logout;
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.session().status, 'logged_out');
  assert.equal(h.disk.size, 0);
});

test('failed credential write blocks fresh auth loading and preserves files', async () => {
  const gate = deferred();
  const h = harness({ saveGates: [gate] });
  await h.start();
  h.update(h.sockets[0], { pairing: 'saved' });
  await h.close(h.sockets[0], 515);
  await h.tick();
  gate.reject(new Error('disk write failed'));
  await flush();
  assert.equal(h.reads.length, 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.deleted.length, 0);
  assert.ok(h.logs.some(line => line.includes('credential persistence failed')));
});

test('connectionReplaced suppresses reconnect and preserves auth', async () => {
  const h = harness({ registered: true });
  await h.start();
  h.context.scheduleReconnect('tenant');
  await h.close(h.sockets[0], 440);
  assert.equal(h.timers.size, 0);
  assert.equal(h.deleted.length, 0);
});

test('unregistered non-515 close still waits for explicit pairing', async () => {
  const h = harness();
  await h.start();
  await h.close(h.sockets[0], 408);
  assert.equal(h.timers.size, 0);
  assert.ok(h.logs.some(line => line.startsWith('Unregistered WhatsApp session closed')));
});

test('registered transient disconnect still reconnects with preserved auth', async () => {
  const h = harness({ registered: true });
  await h.start();
  await h.close(h.sockets[0], 408);
  await h.tick();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.deleted.length, 0);
});

test('gateway startup restores registered persisted credentials', async () => {
  const h = harness();
  h.disk.set('/data/whatsapp-sessions/tenant', { registered: true, pairing: 'persisted' });
  await h.context.restorePersistedSessions();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].auth.creds.pairing, 'persisted');
  assert.equal(h.deleted.length, 0);
});

test('public session state never reports connected without a live socket', () => {
  const h = harness();
  const session = h.context.getOrCreateSession('tenant');
  session.status = 'connected';
  session.phone = '5511999999999';
  session.sock = undefined;

  const state = h.context.getPublicSessionState(session);
  assert.equal(state.status, 'disconnected');
  assert.equal(state.phone, null);
  assert.equal(state.requiresPairing, false);
  assert.equal(state.reason, null);
});

test('401 logged_out state is explicit and requires a new pairing', async () => {
  const h = harness({ registered: true });
  await h.start();
  await h.close(h.sockets[0], 401);

  const state = h.context.getPublicSessionState(h.session());
  assert.equal(state.status, 'logged_out');
  assert.equal(state.requiresPairing, true);
  assert.equal(state.reason, 'pairing_required');
  assert.equal(state.phone, null);
});

test('production logging is privacy hardened for WhatsApp payloads and Signal session dumps', () => {
  assert.match(source, /BAILEYS_LOG_LEVEL \|\| "warn"/);
  assert.match(source, /"remoteJid"/);
  assert.match(source, /"text"/);
  assert.match(source, /isSensitiveSignalSessionDump/);
  assert.match(source, /Closing \(\?:stale open \|open \)\?session/);
  assert.match(source, /baileysLogger\.child\(\{ sessionId: id \}\)/);
});
