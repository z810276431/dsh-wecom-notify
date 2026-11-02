#!/usr/bin/env node
/**
 * DeepSeek Harness notification CLI.
 * Poll persisted turn/end events and send through the configured transport.
 * Only persisted events are observable; hard shutdown/crash may omit a final event.
 * Usage: node dsh-wechat-notify.js [--test | --once]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const net = require('net');

const CONFIG_PATH = process.env.DSH_WECHAT_CONFIG || path.join(__dirname, 'dsh-wechat-config.json');
const STATE_PATH = process.env.DSH_WECHAT_STATE || path.join(__dirname, 'dsh-wechat-state.json');
const LOG_PATH = process.env.DSH_WECHAT_LOG || path.join(__dirname, 'dsh-wechat-notify.log');

// ---------------------------------------------------------------- helpers

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
  process.stdout.write(line);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new Error(`Cannot read valid JSON from ${path.basename(file)}; check file format and permissions.`);
  }
}

function saveJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function postJson(url, payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid notification URL.' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return resolve({ ok: false, error: 'Only HTTP(S) is supported.' });
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
    }, (res) => {
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > 1024 * 1024) { req.destroy(new Error('Response exceeds size limit.')); return; }
        body += chunk;
      });
      res.on('error', (error) => resolve({ ok: false, error: error.message }));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Notification request timed out.')));
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.end(data);
  });
}

function parseProviderResponse(res, transport) {
  if (!res.ok) return { ok: false, error: res.error || `HTTP status ${res.status || 'unknown'}` };
  let json;
  try { json = JSON.parse(res.body); } catch { return { ok: false, error: 'Provider returned invalid JSON.' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'Provider response must be a JSON object.' };
  if (transport === 'pushplus') {
    return json.code === 200
      ? { ok: true, accepted: true, messageId: json.data }
      : { ok: false, error: `PushPlus code=${json.code} ${json.msg || ''}` };
  }
  if (transport === 'serverchan') {
    const code = json.code !== undefined ? json.code : json.errno;
    return code === 0 ? { ok: true } : { ok: false, error: `ServerChan code=${code} ${json.message || json.errmsg || ''}` };
  }
  return json.errcode === 0 ? { ok: true } : { ok: false, error: `WeCom errcode=${json.errcode} ${json.errmsg || ''}` };
}

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = {
  transport: 'webhook',
  wecomWebhook: '',
  pushplus: { token: '', template: 'markdown', channel: 'wechat' },
  serverchan: { sendKey: '' },
  aibot: { botId: '', secret: '', chatFile: '' },
  sessionsRoot: '',
  pollMs: 2000,
  notifyOn: ['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens'],
  mention: '',
  maxTextChars: 220,
  lockPort: 39271,
  requireHarness: true,
  harnessPort: 0,
  harnessProcess: 'DeepSeek Harness.exe',
  harnessExecutable: '',
};

function normalizeConfig(input, baseDir = __dirname, homeDir = require('node:os').homedir()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Configuration must be a JSON object.');
  }
  const result = { ...structuredClone(DEFAULT_CONFIG), ...input };
  for (const key of ['pushplus', 'serverchan', 'aibot']) {
    if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) {
      throw new Error(`Configuration ${key} must be an object.`);
    }
    result[key] = { ...DEFAULT_CONFIG[key], ...input[key] };
  }
  if (!['webhook', 'aibot', 'pushplus', 'serverchan'].includes(result.transport)) {
    throw new Error('Unsupported transport.');
  }
  for (const [key, minimum, maximum] of [['pollMs', 100, 3600000], ['maxTextChars', 0, 10000], ['lockPort', 1, 65535], ['harnessPort', 0, 65535]]) {
    if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > maximum) {
      throw new Error(`Configuration ${key} must be an integer between ${minimum} and ${maximum}.`);
    }
  }
  if (typeof result.requireHarness !== 'boolean') throw new Error('requireHarness must be a boolean.');
  if (!Array.isArray(result.notifyOn) || result.notifyOn.some((kind) => !['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked'].includes(kind))) {
    throw new Error('notifyOn must be an array of supported end reasons.');
  }
  for (const key of ['sessionsRoot', 'wecomWebhook', 'mention', 'harnessProcess', 'harnessExecutable']) {
    if (typeof result[key] !== 'string') throw new Error(`Configuration ${key} must be a string.`);
  }
  for (const [section, keys] of [['aibot', ['botId', 'secret', 'chatFile']], ['pushplus', ['token', 'template', 'channel']], ['serverchan', ['sendKey']]]) {
    for (const key of keys) {
      if (typeof result[section][key] !== 'string') throw new Error(`Configuration ${section}.${key} must be a string.`);
    }
  }
  result.sessionsRoot = result.sessionsRoot.trim() || path.join(homeDir, '.dsh', 'sessions');
  result.aibot.chatFile = result.aibot.chatFile.trim() || path.join(baseDir, 'dsh-wecom-chat.json');
  return result;
}

function validateTransport(config) {
  const needed = config.transport === 'aibot'
    ? [config.aibot.botId, config.aibot.secret]
    : config.transport === 'pushplus' ? [config.pushplus.token]
      : config.transport === 'serverchan' ? [config.serverchan.sendKey] : [config.wecomWebhook];
  if (needed.some((value) => !value.trim())) throw new Error(`Missing credentials for transport ${config.transport}. Fill in the local configuration.`);
  if (config.transport === 'webhook') {
    let url;
    try { url = new URL(config.wecomWebhook); } catch { throw new Error('wecomWebhook must be a valid HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('wecomWebhook must use HTTP(S).');
  }
}

// Imports are inert: private configuration/state is read only by the CLI bootstrap.
let cfg = normalizeConfig({});
let state = { files: {}, sessions: {} };

function initialize() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('Node.js with Zstandard support is required; use Node.js 24 or later.');
  }
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('Local configuration is missing. Run pnpm init:config first.');
  cfg = normalizeConfig(loadJson(CONFIG_PATH));
  validateTransport(cfg);
  state = loadJson(STATE_PATH, { files: {}, sessions: {} });
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
    throw new Error('Invalid scanner state. Preserve the state file and repair it before restarting.');
  }
  state.sessions = state.sessions || {};
  if (typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    throw new Error('Invalid scanner metadata. Preserve and repair the state file before restarting.');
  }
}

// ---------------------------------------------------------------- 智能机器人（AI Bot）长连接

let aibot = null;
let lockServer = null;

function initAibot() {
  if (cfg.transport !== 'aibot') return;
  const { WeComAiBot } = require('./dsh-wecom-aibot.js');
  aibot = new WeComAiBot({
    botId: cfg.aibot.botId,
    secret: cfg.aibot.secret,
    chatFile: cfg.aibot.chatFile,
    log,
  });
  aibot.start();
}

// ---------------------------------------------------------------- zstd 多帧解码

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function magicOffsets(buf, from) {
  const out = [];
  for (let i = Math.max(0, from); i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) out.push(i);
  }
  return out;
}

/**
 * 解码从 from 之后新增的 zstd 帧。
 * 会话日志是"每写一段就追加一个独立 zstd 帧"的结构，因此按帧解码最可靠。
 * 返回 { lines, nextOffset }：nextOffset 为下次应继续的位置。
 */
function zstdFrameEnd(buf, start) {
  let cursor = start + 4;
  if (cursor >= buf.length) return null;
  const descriptor = buf[cursor++];
  if (descriptor & 0x08) throw new Error('Reserved Zstandard header bit.');
  const singleSegment = !!(descriptor & 0x20);
  if (!singleSegment) cursor++;
  cursor += [0, 1, 2, 4][descriptor & 3];
  cursor += [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  if (cursor > buf.length) return null;
  for (;;) {
    if (cursor + 3 > buf.length) return null;
    const header = buf.readUIntLE(cursor, 3);
    cursor += 3;
    const type = (header >>> 1) & 3;
    if (type === 3) throw new Error('Reserved Zstandard block type.');
    cursor += type === 1 ? 1 : header >>> 3;
    if (cursor > buf.length) return null;
    if (header & 1) break;
  }
  if (descriptor & 0x04) cursor += 4;
  return cursor <= buf.length ? cursor : null;
}

function decodeZstdAppend(buf, from) {
  const frames = [];
  let cursor = from;
  for (const start of magicOffsets(buf, from)) {
    if (start < cursor) continue; // A magic sequence inside a block is not another frame.
    let end;
    try { end = zstdFrameEnd(buf, start); } catch { continue; }
    if (end === null) break; // Never consume an incomplete frame, even if Node yields partial output.
    try {
      frames.push({ start, data: zlib.zstdDecompressSync(buf.subarray(start, end)) });
    } catch { /* Skip a fully present but invalid frame. */ }
    cursor = end;
  }
  const decoded = Buffer.concat(frames.map((frame) => frame.data));
  const consumed = decoded.lastIndexOf(0x0a) + 1;
  const lines = decoded.subarray(0, consumed).toString('utf8').split('\n').filter((line) => line.trim());
  let nextOffset = cursor;
  if (consumed < decoded.length) {
    let offset = 0;
    for (const frame of frames) {
      offset += frame.data.length;
      if (offset > consumed) { nextOffset = frame.start; break; }
    }
  }
  return { lines, nextOffset };
}

function decodePlainAppend(buf, from) {
  const slice = buf.slice(from);
  const text = slice.toString('utf8');
  const parts = text.split('\n');
  const tail = parts.pop();                  // 最后一段可能还没写完
  const lines = parts.filter((l) => l.trim());
  const consumed = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return { lines, nextOffset: from + consumed };
}

/** 文件头部指纹：用于判断日志是"追加"还是被整体重写。 */
function prefixHash(buf) {
  const n = Math.min(4096, buf.length);
  const h = require('crypto').createHash('sha1');
  h.update(buf.subarray(0, n));
  return `${n}:${h.digest('hex')}`;
}

// ---------------------------------------------------------------- 会话日志扫描

function listLogFiles(root) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const ws = path.join(root, d.name);
    let sessions;
    try { sessions = fs.readdirSync(ws, { withFileTypes: true }); } catch (_) { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const sd = path.join(ws, s.name);
      for (const name of ['session.v4.jsonl', 'session.v4.jsonl.zstd']) {
        const f = path.join(sd, name);
        try {
          const st = fs.statSync(f);
          if (st.isFile()) out.push({ file: f, sessionId: s.name, workspace: d.name, size: st.size, mtime: st.mtimeMs });
        } catch (_) {}
      }
    }
  }
  return out;
}

/** 收集一个会话的元信息（cwd / 标题 / 最后一条助手文本）。 */
function collectMeta(lines, meta) {
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (o.type === 'session') meta.cwd = o.data?.cwd || meta.cwd;
    else if (o.type === 'session/title') meta.title = o.data?.title || meta.title;
    else if (o.type === 'turn/start') meta.lastText = '';
    else if (o.type === 'assistant/message') {
      const content = o.data?.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
      if (text) meta.lastText = text;
    }
  }
  return meta;
}

// ---------------------------------------------------------------- 通知

/** 当前通道的人类可读名称，用于日志与测试消息。 */
function transportLabel() {
  switch (cfg.transport) {
    case 'aibot':      return '企业微信智能机器人长连接（进企业微信）';
    case 'pushplus':   return 'PushPlus（微信服务号 → 个人微信）';
    case 'serverchan': return 'Server酱（微信服务号 → 个人微信）';
    default:           return '企业微信群机器人 Webhook（进企业微信）';
  }
}

function statusOf(kind, reason) {
  switch (kind) {
    case 'completed':   return { icon: '✅', label: '任务完成' };
    case 'aborted':     return { icon: '⚠️', label: '任务被中断（用户取消）' };
    case 'interrupted': return { icon: '⚠️', label: '任务被中断' };
    case 'blocked':     return { icon: '🔒', label: '任务被阻塞' };
    case 'error':       return { icon: '❌', label: '任务出错' };
    case 'max-tokens':  return { icon: '⚠️', label: '达到输出上限' };
    case 'forked':      return { icon: '🌱', label: '派生新会话' };
    default:            return { icon: 'ℹ️', label: `轮次结束（${kind}）` };
  }
}

/**
 * 统一发送入口。按 cfg.transport 分派到不同通道。
 *
 *  webhook    企微群机器人  → 消息进「企业微信」群（不是个人微信）
 *  aibot      企微智能机器人 → 长连接，同样进企业微信
 *  pushplus   PushPlus      → 通过微信服务号推送到「个人微信」
 *  serverchan Server酱      → 通过微信服务号推送到「个人微信」
 */
async function sendWecom(content, title) {
  const t = title || 'DeepSeek Harness 通知';
  if (cfg.transport === 'aibot') {
    if (!aibot) return { ok: false, error: 'aibot is not initialized.' };
    return aibot.sendMarkdown(content);
  }
  if (cfg.transport === 'pushplus') {
    const res = await postJson('https://www.pushplus.plus/send', {
      token: cfg.pushplus.token,
      title: t,
      content,
      template: cfg.pushplus.template,
      channel: cfg.pushplus.channel,
    });
    return parseProviderResponse(res, 'pushplus');
  }
  if (cfg.transport === 'serverchan') {
    const res = await postJson(`https://sctapi.ftqq.com/${encodeURIComponent(cfg.serverchan.sendKey)}.send`, {
      title: Array.from(t).slice(0, 32).join(''),
      desp: content,
    });
    return parseProviderResponse(res, 'serverchan');
  }
  const res = await postJson(cfg.wecomWebhook, { msgtype: 'markdown', markdown: { content } });
  return parseProviderResponse(res, 'webhook');
}

function buildContent(kind, reason, meta, turn, config = cfg) {
  const st = statusOf(kind, reason);
  const lines = [`### ${st.icon} ${st.label}`];
  if (config.mention) lines.push(config.mention);
  if (meta.title) lines.push(`> **任务**：${meta.title}`);
  lines.push(`> 工作区：\`${meta.cwd || meta.workspace || '-'}\``);
  lines.push(`> 轮次：${turn}　结束原因：\`${kind}\``);
  if (reason && typeof reason === 'object' && reason.reason) {
    lines.push(`> 原因说明：${reason.reason}`);
  }
  if (kind !== 'completed' && meta.lastText) {
    const t = config.maxTextChars === 0 ? '' : meta.lastText.slice(-config.maxTextChars);
    if (t) lines.push(`> 中断前进度：${t}`);
  }
  lines.push(`> 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  const title = meta.title ? `${st.icon} ${st.label} · ${meta.title}` : `${st.icon} ${st.label}`;
  return { content: lines.join('\n'), st, title };
}

// ---------------------------------------------------------------- 主流程

async function scanOnce() {
  const files = listLogFiles(cfg.sessionsRoot);
  for (const f of files) {
    const key = f.file;
    const st = state.files[key] || { offset: 0, lastSeq: 0, notifiedSeq: 0, bootstrapped: false };
    let buf;
    try { buf = fs.readFileSync(f.file); } catch (_) { continue; }

    // 日志被整体重写（而非追加）时，偏移量失效 -> 从头重读。
    // 头部指纹或长度对不上都视为重写；已通知过的高水位用 notifiedSeq 保留，不会重复推送。
    const ph = prefixHash(buf);
    if (st.bootstrapped && (st.prefixHash !== ph || buf.length < (st.offset || 0))) {
      st.notifiedSeq = Math.max(st.notifiedSeq || 0, st.lastSeq || 0);
      st.offset = 0;
      st.lastSeq = 0;
    }
    st.prefixHash = ph;
    if (st.notifiedSeq === undefined) st.notifiedSeq = st.lastSeq || 0;

    let lines = [];
    if (st.offset === 0 && st.lastSeq === 0 && !st.bootstrapped) {
      // 首次见到这个文件：整份读进来只建立基线，不发通知
      if (f.file.endsWith('.zstd')) {
        const r = decodeZstdAppend(buf, 0);
        lines = r.lines; st.offset = r.nextOffset;
      } else {
        const r = decodePlainAppend(buf, 0);
        lines = r.lines; st.offset = r.nextOffset;
      }
      st.bootstrapped = true;
      for (const l of lines) { try { const o = JSON.parse(l); if (typeof o.seq === 'number') st.lastSeq = Math.max(st.lastSeq, o.seq); } catch (_) {} }
      // 基线：历史轮次一律视为"已知"，不补发通知
      st.notifiedSeq = st.lastSeq;
      const metadata = collectMeta(lines, state.sessions[f.sessionId] || {});
      metadata.workspace = f.workspace;
      state.sessions[f.sessionId] = metadata;
      state.files[key] = st;
      continue;
    }

    if (buf.length === st.offset) { state.files[key] = st; continue; }  // 没有新增

    if (f.file.endsWith('.zstd')) {
      const r = decodeZstdAppend(buf, st.offset);
      lines = r.lines; st.offset = r.nextOffset;
    } else {
      const r = decodePlainAppend(buf, st.offset);
      lines = r.lines; st.offset = r.nextOffset;
    }

    const sMeta = state.sessions[f.sessionId] || {};
    sMeta.workspace = f.workspace;
    state.sessions[f.sessionId] = sMeta;

    for (const l of lines) {
      let o;
      try { o = JSON.parse(l); } catch (_) { continue; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      if (typeof o.seq === 'number') st.lastSeq = Math.max(st.lastSeq, o.seq);
      collectMeta([l], sMeta);
      if (o.type !== 'turn/end' || !o.data || typeof o.data !== 'object' || !o.data.reason) continue;
      if (typeof o.seq === 'number' && o.seq <= (st.notifiedSeq || 0)) continue;  // 已通知过
      const kind = o.data?.reason?.kind;
      if (!kind) continue;
      if (!cfg.notifyOn.includes(kind)) continue;
      const { content, title } = buildContent(kind, o.data.reason, sMeta, o.data.turn);
      const res = await sendWecom(content, title);
      if (typeof o.seq === 'number') st.notifiedSeq = o.seq;
      log(`notify session=${f.sessionId} turn=${o.data.turn} kind=${kind} -> ${res.ok ? 'ok' : 'FAIL ' + (res.error || res.body)}`);
    }
    state.files[key] = st;
  }
  saveJson(STATE_PATH, state);
}

/**
 * 单实例锁：独占绑定一个本地端口。
 * 开机自启 + 手动启动可能同时存在两个实例；企微规定同一机器人同时只能有一个长连接，
 * 两个实例会互相踢对方的连接，陷入重连风暴并导致消息重复推送。
 */
function acquireInstanceLock(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') return resolve(false);
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => { lockServer = server; resolve(true); });
  });
}

function closeInstanceLock() {
  const server = lockServer;
  lockServer = null;
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

function probeProcess(name) {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const command = windows ? 'tasklist' : 'ps';
    const args = windows ? ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='];
    require('node:child_process').execFile(command, args,
      { timeout: 6000, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return resolve(false);
        const expected = name.toLowerCase();
        const found = String(stdout || '').split(/\r?\n/).some((line) => windows
          ? line.trim().toLowerCase().startsWith(`"${expected}",`)
          : path.basename(line.trim()).toLowerCase() === expected);
        resolve(found);
      });
  });
}

function resolveHarnessEndpoint(config, webUrl = process.env.DSH_WEB_URL) {
  let host = '127.0.0.1';
  let port = config.harnessPort;
  if (webUrl) {
    try {
      const url = new URL(webUrl);
      if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        host = url.hostname.replace(/^\[|\]$/g, '');
        if (!port) port = Number(url.port);
      }
    } catch {}
  }
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

function resolveHarnessPort(config, webUrl = process.env.DSH_WEB_URL) {
  return resolveHarnessEndpoint(config, webUrl)?.port || 0;
}

async function isHarnessRunning(config, tcpProbe = probeTcp, processProbe = probeProcess, webUrl = process.env.DSH_WEB_URL) {
  if (!config.requireHarness) return true;
  const endpoint = resolveHarnessEndpoint(config, webUrl);
  if (endpoint && await tcpProbe(endpoint.host, endpoint.port, 400)) return true;
  return config.harnessProcess.trim() ? processProbe(config.harnessProcess) : false;
}

function sleep(ms, signal) {
  return require('node:timers/promises').setTimeout(ms, undefined, { signal }).catch((error) => {
    if (error.name !== 'AbortError') throw error;
  });
}

async function ensureAibotReady(signal) {
  if (cfg.transport !== 'aibot') return;
  if (!aibot) initAibot();
  await aibot.waitUntilReady(15000, signal);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node dsh-wechat-notify.js [--test | --once]\n--test sends one test message; --once scans once; no flag runs the daemon.');
    return;
  }
  if (args.some((arg) => !['--test', '--once'].includes(arg)) || (args.includes('--test') && args.includes('--once'))) {
    throw new Error('Use either --test, --once, or no flag.');
  }
  initialize();
  const isTest = args.includes('--test');
  const isOnce = args.includes('--once');
  const isAibot = cfg.transport === 'aibot';
  let stopping = false;
  const shutdown = new AbortController();
  const requestStop = () => { stopping = true; shutdown.abort(); };
  try {
    // HTTP tests are independent; aibot tests must not replace a live bot connection.
    if (!isTest || isAibot) {
      if (!await acquireInstanceLock(cfg.lockPort)) {
        log(`已有实例在运行（锁端口 ${cfg.lockPort}），本次退出，避免消息重复。`);
        if (isTest || isOnce) process.exitCode = 1;
        return;
      }
    }
    if (isTest) {
      await ensureAibotReady();
      const result = await sendWecom([
        '### ✅ 测试消息',
        '> DeepSeek Harness 通知通道测试',
        `> 通道：${transportLabel()}`,
        `> 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ].join('\n'), '✅ 测试消息 · DeepSeek Harness');
      log('test -> ' + JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (isOnce) {
      await ensureAibotReady();
      await scanOnce();
      log('once scan done');
      return;
    }

    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);
    log(`watching session logs (poll ${cfg.pollMs}ms) | ${transportLabel()}`);
    let previousUp = null;
    while (!stopping) {
      const up = await isHarnessRunning(cfg);
      if (stopping) break;
      if (up !== previousUp) {
        log(up ? '>> DeepSeek Harness 已启动：开始监听' : '<< DeepSeek Harness 未运行：暂停监听');
      }
      if (up) {
        try {
          await ensureAibotReady(shutdown.signal);
          if (stopping) break;
          await scanOnce();
        } catch (error) { if (!stopping) log('scan error: ' + error.message); }
      } else if (previousUp === true) {
        // Drain once, while the existing bot connection is still authenticated.
        if (!isAibot || (aibot && aibot.subscribed)) {
          try { await scanOnce(); } catch (error) { log('final scan error: ' + error.message); }
        }
        if (aibot) { aibot.stop(); aibot = null; }
      }
      // Initial/continued idle state deliberately performs no session scans.
      previousUp = up;
      if (!stopping) await sleep(cfg.pollMs, shutdown.signal);
    }
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    if (aibot) { aibot.stop(); aibot = null; }
    await closeInstanceLock();
  }
}

if (require.main === module) {
  main().catch((error) => { log('fatal: ' + error.message); process.exitCode = 1; });
}

module.exports = {
  normalizeConfig, validateTransport, postJson, parseProviderResponse,
  decodeZstdAppend, decodePlainAppend, prefixHash, listLogFiles,
  collectMeta, statusOf, buildContent, resolveHarnessPort, resolveHarnessEndpoint, isHarnessRunning, sleep,
};

