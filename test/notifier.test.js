'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const notifier = require('../dsh-wechat-notify.js');
const { WeComAiBot } = require('../dsh-wecom-aibot.js');
const { initConfig } = require('../scripts/init-config.js');
const cli = path.resolve(__dirname, '..', 'dsh-wechat-notify.js');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notifier-test-'));
  const verified = fs.realpathSync(root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), verified, 'Only remove the test-owned directory');
    fs.rmSync(verified, { recursive: true, force: true });
  });
  return root;
}

function run(args, env, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated CLI timed out')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function availablePort() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, webhook = 'http://127.0.0.1:1/') {
  const root = temporary(t);
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot);
  const config = {
    transport: 'webhook', wecomWebhook: webhook, sessionsRoot,
    requireHarness: false, pollMs: 100, lockPort: await availablePort(),
  };
  const configFile = path.join(root, 'local-config.json');
  const env = {
    DSH_WECHAT_CONFIG: configFile,
    DSH_WECHAT_STATE: path.join(root, 'state.json'),
    DSH_WECHAT_LOG: path.join(root, 'notify.log'),
    DSH_WEB_URL: '',
  };
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { root, config, env, save: () => fs.writeFileSync(configFile, JSON.stringify(config)) };
}

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/`;
}

function sample(kind, seq) {
  return JSON.stringify({ type: 'turn/end', seq, data: { turn: seq, reason: { kind } } }) + '\n';
}

function botFor(t) {
  const root = temporary(t);
  const bot = new WeComAiBot({ botId: '', secret: '', chatFile: path.join(root, 'chat.json') });
  t.after(() => bot.stop());
  return bot;
}

test('import does not read private config/state or run the CLI', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.env.DSH_WECHAT_CONFIG, 'PRIVATE_CONFIG_MARKER: invalid JSON');
  fs.writeFileSync(f.env.DSH_WECHAT_STATE, 'PRIVATE_STATE_MARKER: invalid JSON');
  const code = await run(['-e', `require(${JSON.stringify(cli)})`], f.env);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(f.env.DSH_WECHAT_LOG), false);
  assert.equal(fs.readFileSync(f.env.DSH_WECHAT_STATE, 'utf8'), 'PRIVATE_STATE_MARKER: invalid JSON');
});

test('empty public paths resolve automatically and nested defaults merge', () => {
  const home = path.join(os.tmpdir(), 'sample-home');
  const base = path.join(os.tmpdir(), 'sample-source');
  const config = notifier.normalizeConfig({ sessionsRoot: '', aibot: { botId: '' } }, base, home);
  assert.equal(config.sessionsRoot, path.join(home, '.dsh', 'sessions'));
  assert.equal(config.aibot.chatFile, path.join(base, 'dsh-wecom-chat.json'));
  assert.equal(config.aibot.secret, '');
  assert.equal(config.harnessPort, 0);
});

test('config rejects invalid types, ranges, providers and missing active credentials', () => {
  for (const config of [null, [], { transport: 'unknown' }, { pollMs: 0 }, { lockPort: 0 }, { harnessPort: 65536 }, { requireHarness: 'yes' }, { notifyOn: ['unknown'] }, { aibot: [] }]) {
    assert.throws(() => notifier.normalizeConfig(config));
  }
  assert.throws(() => notifier.validateTransport(notifier.normalizeConfig({})), /Missing credentials/);
});

test('provider success requires 2xx and explicit object-shaped JSON acknowledgement', () => {
  for (const body of ['not-json', 'null', '[]', '"ok"', '{}', '{"errcode":1}', '{"errcode":"0"}']) {
    assert.equal(notifier.parseProviderResponse({ ok: true, body }, 'webhook').ok, false);
  }
  assert.equal(notifier.parseProviderResponse({ ok: false, status: 302 }, 'webhook').ok, false);
  assert.equal(notifier.parseProviderResponse({ ok: true, body: '{"errcode":0}' }, 'webhook').ok, true);
  assert.deepEqual(notifier.parseProviderResponse({ ok: true, body: '{"code":200,"data":"message-id"}' }, 'pushplus'), { ok: true, accepted: true, messageId: 'message-id' });
  assert.equal(notifier.parseProviderResponse({ ok: true, body: '{"errno":0}' }, 'serverchan').ok, true);
});

test('HTTP JSON transport preserves split UTF-8 response data', async (t) => {
  const url = await serverFor(t, (req, res) => {
    req.resume();
    res.setHeader('Connection', 'close');
    const body = Buffer.from('{"errcode":0,"errmsg":"中文"}');
    const offset = body.indexOf(Buffer.from('中')) + 1;
    res.write(body.subarray(0, offset));
    setImmediate(() => res.end(body.subarray(offset)));
  });
  const response = await notifier.postJson(url, { text: 'test' });
  assert.equal(response.ok, true);
  assert.equal(JSON.parse(response.body).errmsg, '中文');
});

test('HTTP redirects are failures rather than provider success', async (t) => {
  const url = await serverFor(t, (req, res) => { req.resume(); res.writeHead(302, { Connection: 'close' }); res.end('{"errcode":0}'); });
  assert.equal((await notifier.postJson(url, {})).ok, false);
});

test('plain JSONL preserves incomplete trailing records', () => {
  const first = sample('completed', 1);
  const tail = sample('aborted', 2);
  const partial = Buffer.from(first + tail.slice(0, -2));
  const decoded = notifier.decodePlainAppend(partial, 0);
  assert.equal(decoded.lines.length, 1);
  assert.equal(decoded.nextOffset, Buffer.byteLength(first));
  const completed = notifier.decodePlainAppend(Buffer.from(first + tail), decoded.nextOffset);
  assert.equal(completed.lines.length, 1);
  assert.equal(JSON.parse(completed.lines[0]).seq, 2);
});

test('Zstandard concatenation and incomplete tail preserve frame cursors', () => {
  const first = zlib.zstdCompressSync(Buffer.from(sample('completed', 1)));
  const second = zlib.zstdCompressSync(Buffer.from(sample('aborted', 2)));
  const all = Buffer.concat([first, second]);
  assert.equal(notifier.decodeZstdAppend(all, 0).lines.length, 2);
  const partial = notifier.decodeZstdAppend(all.subarray(0, all.length - 2), 0);
  assert.equal(partial.lines.length, 1);
  assert.equal(partial.nextOffset, first.length);
  const rest = notifier.decodeZstdAppend(all, partial.nextOffset);
  assert.equal(rest.lines.length, 1);
  assert.equal(JSON.parse(rest.lines[0]).seq, 2);
});

test('zero summary length omits interrupted progress', () => {
  const message = notifier.buildContent('aborted', {}, { title: 'sample', lastText: 'PRIVATE_PROGRESS_MARKER' }, 1, { mention: '', maxTextChars: 0 });
  assert.doesNotMatch(message.content, /PRIVATE_PROGRESS_MARKER/);
});

test('lifecycle probes never guess a GUI port and can remain idle without scanning', async () => {
  const config = notifier.normalizeConfig({ harnessProcess: '', harnessPort: 0 });
  assert.equal(notifier.resolveHarnessPort(config, ''), 0);
  assert.equal(notifier.resolveHarnessPort(config, 'not-a-url'), 0);
  assert.equal(notifier.resolveHarnessPort(config, 'https://example.invalid:1234'), 0);
  assert.equal(notifier.resolveHarnessPort(config, 'http://127.0.0.1:1234'), 1234);
  let probes = 0;
  assert.equal(await notifier.isHarnessRunning(config, async () => { probes++; return false; }, async () => { probes++; return false; }, ''), false);
  assert.equal(probes, 0);
  assert.equal(await notifier.isHarnessRunning({ ...config, requireHarness: false }), true);
});

test('config initialization does not overwrite an existing private configuration', (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'dsh-wechat-config.example.json'), '{}');
  assert.equal(initConfig(root).created, true);
  const filename = path.join(root, 'dsh-wechat-config.json');
  fs.writeFileSync(filename, 'PRIVATE_CONFIGURATION_MARKER');
  assert.equal(initConfig(root).created, false);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'PRIVATE_CONFIGURATION_MARKER');
});

test('once releases mutex; historical events are not replayed across append/rewrite', async (t) => {
  let requests = 0;
  const url = await serverFor(t, (req, res) => { requests++; req.resume(); res.setHeader('Connection', 'close'); res.end('{"errcode":0}'); });
  const f = await fixture(t, url);
  const directory = path.join(f.config.sessionsRoot, 'group', 'session-one');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'session.v4.jsonl');
  const baseline = JSON.stringify({ type: 'session/title', seq: 1, data: { title: 'sample' } }) + '\n' + sample('completed', 2);
  fs.writeFileSync(filename, baseline);
  assert.equal(await run([cli, '--once'], f.env), 0);
  assert.equal(requests, 0);
  fs.appendFileSync(filename, sample('completed', 3));
  assert.equal(await run([cli, '--once'], f.env), 0);
  assert.equal(requests, 1);
  assert.equal(await run([cli, '--once'], f.env), 0);
  assert.equal(requests, 1);
  fs.writeFileSync(filename, 'null\n' + baseline + sample('completed', 3) + sample('aborted', 4));
  assert.equal(await run([cli, '--once'], f.env), 0);
  assert.equal(requests, 2);
  const saved = JSON.parse(fs.readFileSync(f.env.DSH_WECHAT_STATE, 'utf8'));
  assert.equal(saved.files[filename].notifiedSeq, 4);
});

test('test CLI returns nonzero on malformed provider response', async (t) => {
  const url = await serverFor(t, (req, res) => { req.resume(); res.setHeader('Connection', 'close'); res.end('not JSON'); });
  const f = await fixture(t, url);
  assert.equal(await run([cli, '--test'], f.env), 1);
});

test('CLI config errors fail without reading any default local configuration', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.env.DSH_WECHAT_CONFIG, '{broken JSON');
  assert.equal(await run([cli, '--test'], f.env), 1);
  fs.unlinkSync(f.env.DSH_WECHAT_CONFIG);
  assert.equal(await run([cli, '--once'], f.env), 1);
});

test('subscription readiness is authentication state, not socket OPEN', async (t) => {
  const bot = botFor(t);
  bot.ws = { readyState: 1, close() {} };
  await assert.rejects(bot.waitUntilReady(1), /subscription/);
  bot.subscribed = true;
  assert.equal(await bot.waitUntilReady(1), true);
  bot.authError = new Error('authentication rejected');
  await assert.rejects(bot.waitUntilReady(1), /authentication rejected/);
});

test('subscription ACK activates readiness and heartbeat, stop clears pending work', async (t) => {
  const bot = botFor(t);
  bot.ws = { readyState: 1, terminate() {}, send(text) {
    const message = JSON.parse(text);
    setImmediate(() => bot.onMessage(JSON.stringify({ headers: message.headers, errcode: 0 })));
  } };
  await bot.onOpen();
  assert.equal(bot.subscribed, true);
  assert.ok(bot.heartbeatTimer);
  bot.ws.send = () => {};
  const pending = bot.request('ping');
  assert.equal(bot.pending.size, 1);
  bot.stop();
  assert.equal((await pending).errcode, -1);
  assert.equal(bot.pending.size, 0);
  assert.equal(bot.heartbeatTimer, null);
  assert.equal(bot.reconnectTimer, null);
});

test('first notification target is not overwritten by another conversation', (t) => {
  const bot = botFor(t);
  const callback = (chatid) => JSON.stringify({ cmd: 'aibot_msg_callback', body: { chattype: 'group', chatid } });
  bot.onMessage(callback('first-target'));
  bot.onMessage(callback('different-target'));
  assert.equal(bot.chat.chatid, 'first-target');
  assert.equal(JSON.parse(fs.readFileSync(bot.chatFile, 'utf8')).chatid, 'first-target');
});

test('JSON and UTF-8 records split across complete Zstandard frames remain buffered', () => {
  const text = Buffer.from(JSON.stringify({ type: 'session/title', seq: 1, data: { title: '中文' } }) + '\n');
  const split = text.indexOf(Buffer.from('中')) + 1;
  const first = zlib.zstdCompressSync(text.subarray(0, split));
  const second = zlib.zstdCompressSync(text.subarray(split));
  const partial = notifier.decodeZstdAppend(first, 0);
  assert.equal(partial.lines.length, 0);
  assert.equal(partial.nextOffset, 0);
  const result = notifier.decodeZstdAppend(Buffer.concat([first, second]), partial.nextOffset);
  assert.equal(result.lines.length, 1);
  assert.equal(JSON.parse(result.lines[0]).data.title, '中文');
});

test('negative subscription result terminates the stale OPEN socket and schedules retry', async (t) => {
  const bot = botFor(t);
  let terminated = false;
  bot.ws = { readyState: 1, terminate() { terminated = true; } };
  bot.request = async () => ({ errcode: -1, errmsg: 'timeout' });
  await bot.onOpen();
  assert.equal(terminated, true);
  assert.equal(bot.subscribed, false);
  assert.ok(bot.reconnectTimer);
});

test('heartbeat error response triggers reconnect without real clocks or sockets', async (t) => {
  const bot = botFor(t);
  let callback;
  let terminated = false;
  t.mock.method(global, 'setInterval', (fn) => { callback = fn; return 777; });
  t.mock.method(global, 'clearInterval', () => {});
  bot.ws = { readyState: 1, terminate() { terminated = true; } };
  bot.subscribed = true;
  bot.request = async () => ({ errcode: -1 });
  bot.startHeartbeat();
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, true);
  assert.equal(bot.subscribed, false);
  assert.ok(bot.reconnectTimer);
});

test('corrupt saved target fails without silently rebinding it', (t) => {
  const root = temporary(t);
  const filename = path.join(root, 'chat.json');
  fs.writeFileSync(filename, 'INVALID_BINDING_MARKER');
  assert.throws(() => new WeComAiBot({ botId: '', secret: '', chatFile: filename }), /invalid JSON/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'INVALID_BINDING_MARKER');
});

test('idle daemon does not scan and duplicate once cannot replace it', async (t) => {
  let requests = 0;
  const url = await serverFor(t, (req, res) => { requests++; req.resume(); res.setHeader('Connection', 'close'); res.end('{"errcode":0}'); });
  const f = await fixture(t, url);
  f.config.requireHarness = true;
  f.config.harnessProcess = '';
  f.config.harnessPort = 0;
  f.save();
  const directory = path.join(f.config.sessionsRoot, 'group', 'session-idle');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.v4.jsonl'), sample('completed', 1));
  fs.writeFileSync(f.env.DSH_WECHAT_LOG, '');
  let child;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Idle daemon did not start')); }, 5000);
    const watcher = fs.watch(f.env.DSH_WECHAT_LOG, () => {
      if (fs.readFileSync(f.env.DSH_WECHAT_LOG, 'utf8').includes('暂停监听')) {
        clearTimeout(timer); watcher.close(); resolve();
      }
    });
    child = spawn(process.execPath, [cli], { env: { ...process.env, ...f.env }, stdio: 'ignore' });
    child.once('error', (error) => { clearTimeout(timer); watcher.close(); reject(error); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  });
  await ready;
  assert.equal(fs.existsSync(f.env.DSH_WECHAT_STATE), false);
  assert.equal(await run([cli, '--once'], f.env), 1);
  assert.equal(fs.existsSync(f.env.DSH_WECHAT_STATE), false);
  assert.equal(requests, 0);
});

test('earlier interrupted event never includes later turn progress in one batch', async (t) => {
  const notifications = [];
  const url = await serverFor(t, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      notifications.push(JSON.parse(body).markdown.content);
      res.setHeader('Connection', 'close');
      res.end('{"errcode":0}');
    });
  });
  const f = await fixture(t, url);
  const directory = path.join(f.config.sessionsRoot, 'group', 'session-mixed');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'session.v4.jsonl');
  const event = (type, seq, data) => JSON.stringify({ type, seq, data }) + '\n';
  fs.writeFileSync(filename, event('session/title', 1, { title: 'sample' }));
  assert.equal(await run([cli, '--once'], f.env), 0);
  fs.appendFileSync(filename,
    event('turn/start', 2, {}) +
    event('assistant/message', 3, { message: { content: [{ type: 'text', text: 'EARLIER_PROGRESS' }] } }) +
    sample('aborted', 4) +
    event('turn/start', 5, {}) +
    event('assistant/message', 6, { message: { content: [{ type: 'text', text: 'LATER_PROGRESS' }] } }));
  assert.equal(await run([cli, '--once'], f.env), 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /EARLIER_PROGRESS/);
  assert.doesNotMatch(notifications[0], /LATER_PROGRESS/);
});

test('IPv6 GUI hostname is preserved for the injected TCP probe', async () => {
  const config = notifier.normalizeConfig({ harnessPort: 0, harnessProcess: '' });
  let observed;
  const up = await notifier.isHarnessRunning(config, async (host, port) => {
    observed = { host, port }; return true;
  }, async () => false, 'http://[::1]:1234');
  assert.equal(up, true);
  assert.deepEqual(observed, { host: '::1', port: 1234 });
});

test('abort wakes a one-hour polling wait and cancels subscription readiness', async (t) => {
  const controller = new AbortController();
  const waiting = notifier.sleep(3600000, controller.signal);
  controller.abort();
  await waiting;
  const bot = botFor(t);
  await assert.rejects(bot.waitUntilReady(15000, controller.signal), { name: 'AbortError' });
});
