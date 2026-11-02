'use strict';
/** WeCom intelligent-bot client: subscription, heartbeat, target binding and reconnect. */
const fs = require('node:fs');
const crypto = require('node:crypto');

const WS_URL = 'wss://openws.work.weixin.qq.com';

function openSocket(handlers, log) {
  let WS;
  try { WS = require('ws'); }
  catch { throw new Error('Missing ws dependency. Run pnpm install before using aibot.'); }
  log('aibot: 使用 ws 库');
  const socket = new WS(WS_URL);
  socket.on('open', handlers.onopen);
  socket.on('message', (data) => handlers.onmessage(data.toString('utf8')));
  socket.on('close', (code, reason) => handlers.onclose({ code, reason: reason.toString('utf8') }));
  socket.on('error', (error) => handlers.onerror(error));
  return socket;
}

class WeComAiBot {
  constructor(options) {
    this.botId = options.botId;
    this.secret = options.secret;
    this.chatFile = options.chatFile;
    this.log = options.log || (() => {});
    this.ws = null;
    this.pending = new Map();
    this.chat = this.loadChat();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.stopped = false;
    this.subscribed = false;
    this.authError = null;
  }

  loadChat() {
    let text;
    try { text = fs.readFileSync(this.chatFile, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Cannot read the saved WeCom target. Check file permissions.');
    }
    let chat;
    try { chat = JSON.parse(text); } catch { throw new Error('Saved WeCom target contains invalid JSON. Preserve and repair it.'); }
    if (!chat || typeof chat.chatid !== 'string' || !chat.chatid || ![1, 2].includes(chat.chatType)) {
      throw new Error('Saved WeCom target is invalid. Preserve and repair it.');
    }
    return chat;
  }

  saveChat(chat) {
    // Persist first, so an unwritable binding cannot appear successfully configured.
    const temporary = `${this.chatFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(chat, null, 2));
    fs.renameSync(temporary, this.chatFile);
    this.chat = chat;
  }

  start() { this.connect(); }

  connect() {
    if (this.stopped || (this.ws && [0, 1].includes(this.ws.readyState))) return;
    this.subscribed = false;
    this.log('aibot: 正在连接');
    this.ws = openSocket({
      onopen: () => this.onOpen().catch((error) => this.log('aibot: ' + error.message)),
      onmessage: (text) => this.onMessage(text),
      onclose: (event) => this.onClose(event),
      onerror: (error) => this.log('aibot: 连接错误 ' + error.message),
    }, this.log);
  }

  async onOpen() {
    this.subscribed = false;
    this.authError = null;
    const result = await this.request('aibot_subscribe', { bot_id: this.botId, secret: this.secret });
    if (this.stopped) return;
    if (result.errcode === 0) {
      this.subscribed = true;
      this.reconnectDelay = 1000;
      this.log('aibot: 订阅成功');
      this.startHeartbeat();
    } else if (result.errcode !== -1) {
      this.authError = new Error(`WeCom subscription rejected: errcode=${result.errcode}`);
      this.log('aibot: ' + this.authError.message);
      this.stop();
    } else {
      this.retryConnection();
    }
  }

  async waitUntilReady(timeoutMs = 15000, signal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal && signal.aborted) {
        const error = new Error('Subscription wait cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      if (this.authError) throw this.authError;
      if (this.stopped) throw new Error('WeCom client is stopped.');
      if (this.subscribed) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for WeCom subscription.');
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }

  onMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.cmd === 'aibot_msg_callback') {
      const body = message.body || {};
      const group = body.chattype === 'group';
      const chatid = group ? body.chatid : body.from && body.from.userid;
      const chatType = group ? 2 : 1;
      if (!chatid) return;
      if (!this.chat) {
        try {
          this.saveChat({ chatid, chatType, chattype: group ? 'group' : 'single', updatedAt: Date.now() });
          this.log('aibot: 已绑定通知会话');
          this.sendReadyNotice().catch((error) => this.log('aibot: ' + error.message));
        } catch (error) { this.log('aibot: 保存会话失败 ' + error.message); }
      } else if (this.chat.chatid !== chatid || this.chat.chatType !== chatType) {
        this.log('aibot: 忽略其他会话，已保存的通知目标保持不变');
      }
      return;
    }
    if (message.cmd === 'aibot_event_callback') {
      this.log('aibot: 收到事件回调');
      return;
    }
    const id = message.headers && message.headers.req_id;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending.resolve(message);
    }
  }

  onClose(event) {
    this.subscribed = false;
    this.log(`aibot: 连接断开 code=${event && event.code}`);
    this.stopHeartbeat();
    this.failPending('connection closed');
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30000);
    this.log(`aibot: ${delay}ms 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try { this.connect(); } catch (error) { this.log('aibot: ' + error.message); }
    }, delay);
  }

  retryConnection() {
    if (this.stopped) return;
    this.subscribed = false;
    this.stopHeartbeat();
    this.failPending('connection retry');
    const socket = this.ws;
    this.ws = null;
    try {
      if (socket && typeof socket.terminate === 'function') socket.terminate();
      else if (socket) socket.close();
    } catch {}
    this.scheduleReconnect();
  }

  failPending(reason) {
    for (const pending of this.pending.values()) pending.resolve({ errcode: -1, errmsg: reason });
    this.pending.clear();
  }

  async sendReadyNotice() {
    if (!this.chat || !this.subscribed) return;
    await this.request('aibot_send_msg', {
      chatid: this.chat.chatid,
      chat_type: this.chat.chatType,
      msgtype: 'markdown',
      markdown: { content: '✅ **DeepSeek Harness 通知通道已就绪**' },
    });
  }

  request(command, body) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) return resolve({ errcode: -1, errmsg: 'not connected' });
      const id = crypto.randomUUID();
      const payload = { cmd: command, headers: { req_id: id } };
      if (body !== undefined) payload.body = body;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ errcode: -1, errmsg: 'timeout' });
      }, 15000);
      this.pending.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); } });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ errcode: -1, errmsg: error.message });
      }
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.request('ping').then((result) => {
        if (result.errcode !== 0) this.retryConnection();
      }).catch(() => this.retryConnection());
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async sendMarkdown(content) {
    if (!this.subscribed) return { ok: false, error: 'WeCom subscription is not ready.' };
    if (!this.chat || !this.chat.chatid) return { ok: false, error: 'No target conversation. Send a message to the bot in the intended conversation first.' };
    const result = await this.request('aibot_send_msg', {
      chatid: this.chat.chatid,
      chat_type: this.chat.chatType,
      msgtype: 'markdown',
      markdown: { content },
    });
    return result.errcode === 0 ? { ok: true } : { ok: false, error: `WeCom errcode=${result.errcode} ${result.errmsg || ''}` };
  }

  stop() {
    this.stopped = true;
    this.subscribed = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending('client stopped');
    try {
      if (this.ws && typeof this.ws.terminate === 'function') this.ws.terminate();
      else if (this.ws) this.ws.close();
    } catch {}
  }
}

module.exports = { WeComAiBot, WS_URL };
