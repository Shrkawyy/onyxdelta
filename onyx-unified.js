/* =============================================================================
 * ONYX UNIFIED — klient i unifikuar për senpa.io
 * -----------------------------------------------------------------------------
 * Bashkim i implementimeve më të mira nga tre projekte:
 *   • EON   → hapja (key-gating), patch (update-notifier), anti-tracking, HUD,
 *             reconnect, profiles, event bus (EventEmitter), chat bridge.
 *   • ONYX  → modeli single-page dual-connection (window.__connNicks),
 *             arkitektura bazë e UI.
 *   • SENPA → kontrolleri i plotë i multibox-it (Tab1/Tab2, camera centroid,
 *             mouse routing, saigo/spy WS), protokolli binar, chat-i, replay.
 *
 * NATYRA: ky skript është shtresa "mod/control" e deobfuskuar dhe e dokumentuar.
 * Motori real i lojës (vendim-marrja, dekodimi i botës, render) ndodhet në WASM
 * dhe lidhet përmes `EngineAdapter` (shih pikat `@requires engine`).
 *
 * Namespace i vetëm: window.ONYX  (shmang konfliktet globale të tre projekteve).
 * ============================================================================= */
(function (global) {
  'use strict';

  /* ===========================================================================
   * 0. KONFIGURIMI GLOBAL
   * ========================================================================= */
  const CONFIG = {
    version: '1.0.0',
    buildDate: '2026-06-11',

    // Hapja / licenca (EON key.js)
    licenseKeyStorage: 'tm_key',
    licenseVerifyUrl: 'https://morning-math-bdd6.aleksanderlleshaj33.workers.dev/',

    // ─────────────────────────────────────────────────────────────────────
    // SERVERI I LOJËS — Delta FFAEU2 vetëm
    relayUrl: '',
    wsProtocol: '',
    defaultServer: 'eu.senpa.io:2001',
    servers: [
      { id: 'delta-ffaeu2', label: 'Delta FFAEU2 — EU', value: 'eu.senpa.io:2001', type: 'ffa', host: 'eu.senpa.io:2001', wsUrl: 'wss://eu.senpa.io:2001', protocol: 'delta-ffa' },
    ],

    // Chat (SENPA chat.js)
    chatWsUrl: 'wss://chat.delt.io/delta7?protocol=v1',
    chatTrustedOrigin: 'https://delt.io', // EON postMessage bridge

    // Anti-tracking (EON index.html)
    blockedHosts: ['vpnapi.io', 'db-ip.com', 'db-ip.co', 'ipwho.is'],

    // Multibox
    multibox: {
      connections: 2,          // numri i lidhjeve (Tab1, Tab2)
      reconnectBaseMs: 2000,
      reconnectMaxMs: 30000,
      ringType: 'thin',        // basic | thin | thick | mish
      ringWidth: 10,
      activeStroke: '#9250ff',
      inactiveStroke: '#ffffff',
      shield: false,
      cellColor: false,
    },

    hotkeys: {
      multiboxTab: 'Tab',      // ndërro tab-in aktiv
      split: ' ',              // Space
      feed: 'W',
      doubleSplit: 'D',
      tripleSplit: 'F',
      replaySave: 'P',
      toggleRing: 'L',
      respawn: 'B',
    },
  };

  /* ===========================================================================
   * 1. EVENT BUS  (i adoptuar nga EON bundle.js — EventEmitter node-style)
   *    Komunikimi qendror mes të gjitha moduleve.
   * ========================================================================= */
  class EventBus {
    constructor() { this._events = new Map(); }
    on(type, fn) {
      if (!this._events.has(type)) this._events.set(type, new Set());
      this._events.get(type).add(fn);
      return () => this.off(type, fn);
    }
    once(type, fn) {
      const wrap = (...a) => { this.off(type, wrap); fn(...a); };
      return this.on(type, wrap);
    }
    off(type, fn) { this._events.get(type)?.delete(fn); }
    emit(type, ...args) {
      const set = this._events.get(type);
      if (!set) return;
      // kopjojmë që listener-at që heqin veten gjatë emit-it të mos prishin iterimin
      for (const fn of [...set]) {
        try { fn(...args); } catch (e) { console.warn('[ONYX] listener error', type, e); }
      }
    }
    clear() { this._events.clear(); }
  }

  /* ===========================================================================
   * 2. PROTOKOLLI BINAR  (port i pastër nga SENPA chat.js — Writer/Reader)
   *    Përdoret nga lidhjet me serverin (little-endian).
   * ========================================================================= */
  class Writer {
    constructor(size = 8192) {
      this.buffer = new ArrayBuffer(size);
      this.view = new DataView(this.buffer);
      this.bytes = new Uint8Array(this.buffer);
      this.offset = 0;
    }
    writeUInt8(v)  { this.view.setUint8(this.offset++, v & 0xff); return this; }
    writeUInt16(v) { this.view.setUint16(this.offset, v & 0xffff, true); this.offset += 2; return this; }
    writeUInt32(v) { this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; return this; }
    writeInt16(v)  { this.view.setInt16(this.offset, v || 0, true); this.offset += 2; return this; }
    writeInt32(v)  { this.view.setInt32(this.offset, v || 0, true); this.offset += 4; return this; }
    writeFloat32(v){ this.view.setFloat32(this.offset, v || 0, true); this.offset += 4; return this; }
    writeUTF16String(str) {
      for (const ch of String(str || '')) this.writeUInt16(ch.charCodeAt(0));
      return this;
    }
    writeUTF16StringZero(str) { this.writeUTF16String(str); return this.writeUInt16(0); }
    writeUTF16StringLength(str) {
      const s = String(str || '').slice(0, 255);
      this.writeUInt8(s.length);
      return this.writeUTF16String(s);
    }
    finalize() { return this.bytes.slice(0, this.offset); }
  }

  class Reader {
    constructor(data) {
      const buf = data instanceof ArrayBuffer ? data : data.buffer;
      this.view = new DataView(buf, data.byteOffset || 0, data.byteLength || buf.byteLength);
      this.offset = 0;
    }
    get remaining() { return this.view.byteLength - this.offset; }
    readUInt8()  { return this.view.getUint8(this.offset++); }
    readInt8()   { return this.view.getInt8(this.offset++); }
    readUInt16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    readInt16()  { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
    readUInt32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    readFloat32(){ const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
    readUTF16StringLength() {
      const len = this.readUInt8();
      let out = '';
      for (let i = 0; i < len && this.offset + 1 < this.view.byteLength; i++) out += String.fromCharCode(this.readUInt16());
      return out;
    }
  }

  /* ===========================================================================
   * 3. ENGINE ADAPTER  (@requires engine)
   *    Pikë e vetme integrimi me motorin WASM/origjinal të senpa.io.
   *    Lidhe çdo metodë me thirrjet reale të motorit kur ta integrosh.
   * ========================================================================= */
  class EngineAdapter {
    constructor(bus) { this.bus = bus; this.ready = false; }

    /** @requires engine — ngarko & instanco WASM (EON wasmLoader.js / *.wasm) */
    async loadWasm(/* url */) {
      // Pikë integrimi: zëvendëso me ngarkuesin real (wasmLoader.js).
      this.ready = true;
      this.bus.emit('engine:ready');
      return true;
    }

    /** @requires engine — dekodo një paketë boterore në {cells, players} */
    decodeWorld(/* reader */) { return null; }

    /** @requires engine — vizato kornizën aktuale (render) */
    renderFrame() {}
  }

  /* ===========================================================================
   * 4. MULTIBOX CONTROLLER  (BËRTHAMA — sintezë SENPA + ONYX + EON)
   *    Modeli: single-page, N lidhje WebSocket (Tab1, Tab2, ...) nga e njëjta faqe.
   *    - çdo lidhje = një "MultiboxClient" me clientID, qeliza, gjendje alive.
   *    - input-i shkon te tab-i aktiv (ose te të gjitha në auto-mode).
   *    - kamera ndjek centroid-in e qelizave të gjalla.
   *    - rings/shield/cellColor janë ndihma vizuale.
   * ========================================================================= */

  // OPCODE-t e protokollit drejt serverit të lojës (nga SENPA deo.onyx).
  const OP = {
    SPAWN: 0x00,
    MOUSE: 0x05,      // writeUint8(5)+connId+floatX+floatY+uint32 seq
    SPLIT: 0x11,
    EJECT: 0x15,      // feed
  };

  class MultiboxClient {
    /**
     * @param {number} id        indeksi i lidhjes (0 = Tab1, 1 = Tab2)
     * @param {string} url        wss url e serverit
     * @param {EventBus} bus
     */
    constructor(id, url, bus) {
      this.id = id;
      this.url = url;
      this.bus = bus;
      this.ws = null;
      this.clientID = -1;       // caktohet nga handshake (op=1)
      this.alive = false;       // isAliveTab(id)
      this.handshakeDone = false;
      this.cells = new Set();   // cellsIDTab1 / cellsIDTab2
      this.mouse = { x: 0, y: 0 };
      this.seq = 0;
      this.nick = '';
      this.skin = '';
      this._reconnectMs = CONFIG.multibox.reconnectBaseMs;
      this._reconnectTimer = null;
      this._handlers = null;    // mbajmë referencat për removeEventListener (anti-leak)
    }

    connect(nick, skin) {
      this.nick = nick || this.nick;
      this.skin = skin || this.skin;
      this._cleanupSocket();

      // Lidhemi me RELAY-in (jo direkt me senpa.io) duke përdorur protokollin 'main'.
      // Relay-i e çon më tej te serveri i zgjedhur (this.targetServer).
      const proto = CONFIG.wsProtocol;
      const ws = proto ? new WebSocket(this.url, proto) : new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const onOpen = () => {
        this._reconnectMs = CONFIG.multibox.reconnectBaseMs;
        this.bus.emit('client:open', this.id);
        // spawn bëhet vetëm pas handshake (shmang race condition të handshakeDone2)
      };
      const onMessage = (ev) => this._onMessage(ev);
      const onClose = () => {
        this.alive = false;
        this.handshakeDone = false;
        this.bus.emit('client:dead', this.id);
        this._scheduleReconnect();
      };
      const onError = () => { try { ws.close(); } catch (_) {} };

      this._handlers = { onOpen, onMessage, onClose, onError };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    }

    _onMessage(ev) {
      const reader = new Reader(new Uint8Array(ev.data));
      const op = reader.readUInt8();
      if (op === 0x01) {                 // handshake → clientID
        this.clientID = reader.readUInt32();
        this.handshakeDone = true;
        this.bus.emit('client:handshake', this.id, this.clientID);
        this.spawn();                    // tani është e sigurt të bëhet spawn
        return;
      }
      // delego dekodimin e botës te motori (@requires engine)
      this.bus.emit('client:packet', this.id, op, reader);
    }

    spawn() {
      if (!this.handshakeDone || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const w = new Writer(256);
      w.writeUInt8(OP.SPAWN);
      w.writeUTF16StringLength(this.nick);
      w.writeUTF16StringZero(this.skin);
      this.send(w.finalize());
      this.alive = true;
      this.bus.emit('client:alive', this.id);
    }

    /** Dërgo pozicionin e mouse-it për KËTË lidhje (SENPA mouse(x,y,connId)) */
    sendMouse(x, y) {
      this.mouse.x = x; this.mouse.y = y;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const w = new Writer(16);
      w.writeUInt8(OP.MOUSE);
      w.writeUInt8(this.id + 1);   // connId 1-based si te SENPA
      w.writeFloat32(x);
      w.writeFloat32(y);
      w.writeUInt32(this.seq++);
      this.send(w.finalize());
    }

    sendAction(opcode) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send(new Writer(4).writeUInt8(opcode).finalize());
    }

    send(bytes) { try { this.ws.send(bytes); } catch (e) { /* socket mbyllur */ } }

    _scheduleReconnect() {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        this.bus.emit('client:reconnect', this.id);
        this.connect();
      }, this._reconnectMs);
      this._reconnectMs = Math.min(this._reconnectMs * 2, CONFIG.multibox.reconnectMaxMs);
    }

    _cleanupSocket() {
      clearTimeout(this._reconnectTimer);
      if (this.ws && this._handlers) {
        const { onOpen, onMessage, onClose, onError } = this._handlers;
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('message', onMessage);
        this.ws.removeEventListener('close', onClose);
        this.ws.removeEventListener('error', onError);
      }
      try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (_) {}
      this.ws = null;
      this._handlers = null;
    }

    disconnect() { this._cleanupSocket(); this.alive = false; this.handshakeDone = false; }
  }

  class MultiboxController {
    constructor(bus, engine) {
      this.bus = bus;
      this.engine = engine;
      this.clients = [];          // ekspozohet te window.ONYX.multibox.clients (chat.js e lexon)
      this.activeTab = 0;         // tab-i aktiv (merr input-in)
      this.autoBoth = false;      // nëse true, mouse-i shkon te të dyja lidhjet
      this.camera = { x: 0, y: 0 };
    }

    /** Hap N lidhje me pseudonimet/skinet e dhëna (EON Player1/2, Skin1/2) */
    connect(server, nicks, skins) {
      this.disconnect();
      const target = server || CONFIG.defaultServer;   // Delta FFAEU2: eu.senpa.io:2001
      // FFAEU2 should connect directly to the game WebSocket.
      // The previous build constructed MultiboxClient with an empty relay URL,
      // which could add a relay hop (or create an invalid WebSocket URL).
      const directWs = (CONFIG.servers.find(s => s.host === target) || {}).wsUrl
        || ('wss://' + target);
      const n = CONFIG.multibox.connections;
      // ruaj edhe te window.__connNicks për pajtueshmëri me modelin ONYX
      global.__connNicks = nicks.slice(0, n);
      for (let i = 0; i < n; i++) {
        const c = new MultiboxClient(i, directWs, this.bus);
        c.targetServer = target;
        c.connect(nicks[i] || (nicks[0] ? nicks[0] + '-' + (i + 1) : 'player'), skins[i] || '');
        this.clients.push(c);
      }
      this.bus.emit('multibox:connected', this.clients.length);
    }

    get activeClient() { return this.clients[this.activeTab] || null; }

    /** Hotkey: ndërro tab-in aktiv (SENPA multiboxTab()) */
    switchTab() {
      if (this.clients.length < 2) return;
      this.activeTab = (this.activeTab + 1) % this.clients.length;
      this.bus.emit('multibox:tab', this.activeTab);
    }

    /** Routing i mouse-it: tek tab-i aktiv, ose te të dyja në auto-mode */
    routeMouse(x, y) {
      if (this.autoBoth) { for (const c of this.clients) c.sendMouse(x, y); }
      else this.activeClient?.sendMouse(x, y);
    }

    /** Routing i veprimeve (split/feed) — te tab-i aktiv */
    routeAction(opcode) { this.activeClient?.sendAction(opcode); }

    split()  { this.routeAction(OP.SPLIT); }
    feed()   { this.routeAction(OP.EJECT); }
    respawn(){ this.activeClient?.spawn(); }

    /**
     * Camera centroid — qendra ndjek mesataren e qelizave të gjalla.
     * (SENPA: this.x = aliveTab1 && aliveTab2 ? (x1+x2)/2 : ...)
     */
    updateCamera() {
      const alive = this.clients.filter((c) => c.alive);
      if (!alive.length) return;
      let sx = 0, sy = 0;
      for (const c of alive) { sx += c.mouse.x; sy += c.mouse.y; }
      this.camera.x = sx / alive.length;
      this.camera.y = sy / alive.length;
    }

    disconnect() {
      for (const c of this.clients) c.disconnect();
      this.clients = [];
      this.activeTab = 0;
    }
  }

  /* ===========================================================================
   * 5. INPUT ROUTER  (mouse + keyboard → MultiboxController)
   * ========================================================================= */
  class InputRouter {
    constructor(bus, multibox, hotkeys) {
      this.bus = bus;
      this.multibox = multibox;
      this.hotkeys = hotkeys;
      this._onMove = (e) => this.multibox.routeMouse(e.clientX, e.clientY);
      this._onKey = (e) => this.hotkeys.handle(e);
    }
    attach(target = global) {
      target.addEventListener('mousemove', this._onMove);
      target.addEventListener('keydown', this._onKey);
    }
    detach(target = global) {
      target.removeEventListener('mousemove', this._onMove);
      target.removeEventListener('keydown', this._onKey);
    }
  }

  /* ===========================================================================
   * 6. HOTKEY MANAGER  (centralizon hotkey-t — shmang konfliktin P/replay etj.)
   * ========================================================================= */
  class HotkeyManager {
    constructor(bus, multibox, replay) {
      this.bus = bus;
      this.multibox = multibox;
      this.replay = replay;
      this.keys = { ...CONFIG.hotkeys };
    }
    _norm(e) { return e.key.length === 1 ? e.key.toUpperCase() : e.key; }
    handle(e) {
      // mos ndërhy kur shkruan në input/chat
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = this._norm(e);
      switch (k) {
        case this.keys.multiboxTab: e.preventDefault(); this.multibox.switchTab(); break;
        case this.keys.split:       this.multibox.split(); break;
        case this.keys.feed:        this.multibox.feed(); break;
        case this.keys.respawn:     this.multibox.respawn(); break;
        case this.keys.replaySave:  this.replay?.save(); break;
        case this.keys.toggleRing:  this.bus.emit('multibox:toggleRing'); break;
        default: break;
      }
    }
  }

  /* ===========================================================================
   * 7. CHAT CLIENT  (port i kondensuar nga SENPA chat.js — implementimi më i mirë)
   *    - WebSocket me reconnect (backoff), anti-spam, mute, history, send-queue.
   *    - integron me window.ONYX.multibox.clients për clientID.
   *    - fallback: postMessage nga delt.io (EON bridge).
   * ========================================================================= */
  class ChatClient {
    constructor(bus, multibox) {
      this.bus = bus;
      this.multibox = multibox;
      this.ws = null;
      this.connected = false;
      this.muted = new Set(JSON.parse(localStorage.getItem('ONYX_CHAT_MUTED') || '[]'));
      this.sendQueue = [];
      this.lastSend = 0;
      this.recent = [];
      this._reconnectMs = CONFIG.multibox.reconnectBaseMs;
    }

    /** ID stabël fallback kur multibox-i s'ka ende clientID (chat.js fix) */
    _fallbackClientId() {
      const KEY = 'ONYX_CHAT_CLIENT_ID';
      let id = parseInt(sessionStorage.getItem(KEY), 10);
      if (!id || id <= 0) {
        id = (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7fffffff) + 1;
        sessionStorage.setItem(KEY, String(id));
      }
      return id;
    }
    _clientId() {
      const c = (this.multibox.clients || []).find((x) => x?.clientID > 0);
      return Number(c?.clientID) || this._fallbackClientId();
    }

    connect() {
      this._cleanup();
      const ws = new WebSocket(CONFIG.chatWsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.connected = true;
        this._reconnectMs = CONFIG.multibox.reconnectBaseMs;
        this._flushQueue();
        this.bus.emit('chat:open');
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
      ws.addEventListener('close', () => { this.connected = false; this._scheduleReconnect(); });
      ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });

      // EON bridge fallback: mesazhe chat nga delt.io
      this._bridge = (event) => {
        if (event.origin !== CONFIG.chatTrustedOrigin || !event.data) return;
        if (event.data.type === 'DELTA_CHAT') {
          this.bus.emit('chat:message', { name: event.data.name || 'Unknown', text: event.data.text || '' });
        }
      };
      global.addEventListener('message', this._bridge);
    }

    _canSend() {
      const now = Date.now();
      if (now - this.lastSend < 600) return false;
      this.recent = this.recent.filter((t) => t > now - 4000);
      return this.recent.length < 5;
    }

    send(nick, text) {
      text = String(text || '').slice(0, 100).trim();
      if (!text) return;
      if (text.startsWith('/')) return this._command(text);
      if (!this._canSend()) return;
      if (!this.connected) { this.sendQueue.push({ nick, text, ts: Date.now() }); return; }
      const w = new Writer(512);
      w.writeUInt8(0x01);
      w.writeUInt32(this._clientId());
      w.writeUTF16StringLength(nick || 'player');
      w.writeUTF16StringZero(text);
      try { this.ws.send(w.finalize()); this.lastSend = Date.now(); this.recent.push(this.lastSend); } catch (_) {}
    }

    _flushQueue() {
      const now = Date.now();
      const live = this.sendQueue.filter((m) => now - m.ts < 8000);
      this.sendQueue = [];
      for (const m of live) this.send(m.nick, m.text);
    }

    _command(text) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(' ').toLowerCase();
      switch (cmd) {
        case 'mute':   if (arg) { this.muted.add(arg); this._saveMuted(); } break;
        case 'unmute': if (arg) { this.muted.delete(arg); this._saveMuted(); } break;
        case 'clear':  this.bus.emit('chat:clear'); break;
        default: break;
      }
    }
    _saveMuted() { localStorage.setItem('ONYX_CHAT_MUTED', JSON.stringify([...this.muted])); }

    _onMessage(ev) {
      const r = new Reader(new Uint8Array(ev.data));
      const op = r.readUInt8();
      if (op === 0x02) {
        const name = r.readUTF16StringLength();
        const txt = r.readUTF16StringLength();
        if (this.muted.has(name.toLowerCase())) return;
        this.bus.emit('chat:message', { name, text: txt });
      }
    }

    _scheduleReconnect() {
      setTimeout(() => this.connect(), this._reconnectMs);
      this._reconnectMs = Math.min(this._reconnectMs * 2, CONFIG.multibox.reconnectMaxMs);
    }
    _cleanup() {
      if (this._bridge) global.removeEventListener('message', this._bridge);
      try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  /* ===========================================================================
   * 8. REPLAY RECORDER  (port nga SENPA savee.js — ring-buffer webm me header fix)
   * ========================================================================= */
  const REPLAY_MIME = [
    'video/webm;codecs="vp9,opus"', 'video/webm;codecs=vp9',
    'video/webm;codecs="vp8,opus"', 'video/webm;codecs=vp8', 'video/webm',
  ];
  class ReplayRecorder {
    constructor(opts = {}) {
      this.opts = { seconds: 15, fps: 30, timeSliceMs: 500, videoBitsPerSecond: 4_000_000, ...opts };
      this.recorder = null; this.stream = null; this.chunks = [];
      this.headerChunk = null; this.totalBytes = 0;
      this.maxBytes = this.opts.seconds * (this.opts.videoBitsPerSecond / 8) * 1.5;
      this._saving = false;
    }
    get isRecording() { return !!this.recorder && this.recorder.state === 'recording'; }
    _mime() { return REPLAY_MIME.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }); }
    _canvas() {
      let best = null, area = 0;
      document.querySelectorAll('canvas').forEach((c) => {
        const a = (c.width || c.clientWidth) * (c.height || c.clientHeight);
        if (a > area) { area = a; best = c; }
      });
      return best;
    }
    start(canvasEl) {
      if (this.isRecording) return true;
      const canvas = canvasEl || this._canvas();
      const mime = typeof MediaRecorder !== 'undefined' && this._mime();
      if (!canvas || !mime) { console.warn('[OnyxReplay] no canvas/MediaRecorder'); return false; }
      try {
        this.stream = canvas.captureStream(this.opts.fps);
        this.recorder = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: this.opts.videoBitsPerSecond });
        this.chunks = []; this.headerChunk = null; this.totalBytes = 0;
        this.recorder.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          if (!this.headerChunk) { this.headerChunk = e.data; return; } // init segment
          this.chunks.push(e.data); this.totalBytes += e.data.size;
          while (this.totalBytes > this.maxBytes && this.chunks.length > 1) this.totalBytes -= this.chunks.shift().size;
        };
        this.recorder.start(this.opts.timeSliceMs);
        return true;
      } catch (e) { console.warn('[OnyxReplay] start failed', e); this.dispose(); return false; }
    }
    async save(filename) {
      if (this._saving || (!this.isRecording && !this.chunks.length)) return null;
      this._saving = true;
      try {
        try { this.recorder?.requestData(); } catch (_) {}
        await new Promise((r) => setTimeout(r, this.opts.timeSliceMs + 50));
        const parts = this.headerChunk ? [this.headerChunk, ...this.chunks] : [...this.chunks];
        const blob = new Blob(parts, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename || `onyx-replay-${Date.now()}.webm`;
        a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        return blob;
      } finally { this._saving = false; }
    }
    dispose() { // anti-leak: ndalon stream + recorder
      try { this.recorder?.stop(); } catch (_) {}
      try { this.stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this.recorder = null; this.stream = null;
    }
  }

  /* ===========================================================================
   * 9. SETTINGS + PROFILES  (EON: 10 profile, export/import/reset, dual-skin)
   * ========================================================================= */
  class SettingsStore {
    constructor() { this.ns = 'ONYX_SETTINGS'; this.data = this._load(); }
    _load() { try { return JSON.parse(localStorage.getItem(this.ns) || '{}'); } catch { return {}; } }
    get(group, key, dflt) { return this.data?.[group]?.[key] ?? dflt; }
    set(group, key, val) { (this.data[group] ||= {})[key] = val; this._save(); }
    _save() { localStorage.setItem(this.ns, JSON.stringify(this.data)); }
    export() { return JSON.stringify(this.data, null, 2); }
    import(json) { try { this.data = JSON.parse(json); this._save(); return true; } catch { return false; } }
    reset() { this.data = {}; localStorage.removeItem(this.ns); }
  }
  class ProfileManager {
    constructor(store) { this.store = store; this.active = this.store.get('profiles', 'active', 1); }
    select(n) { this.active = n; this.store.set('profiles', 'active', n); }
    /** kthen {tag, nick1, nick2, skin1, skin2, server} për profilin aktiv */
    current() {
      return this.store.get('profiles', 'p' + this.active, {
        tag: '', nick1: '', nick2: '', skin1: '', skin2: '', server: CONFIG.defaultServer,
      });
    }
    save(p) { this.store.set('profiles', 'p' + this.active, p); }
  }

  /* ===========================================================================
   * 10. UPDATE NOTIFIER  (PATCH SYSTEM — EON "What's New")
   * ========================================================================= */
  class UpdateNotifier {
    constructor(store) { this.store = store; }
    /** Shfaq modalin nëse versioni i ruajtur ndryshon nga aktuali */
    maybeShow(notes) {
      const seen = this.store.get('meta', 'version');
      if (seen === CONFIG.version) return false;
      this.store.set('meta', 'version', CONFIG.version);
      const el = document.getElementById('update-notifier-overlay');
      if (el) {
        const v = document.getElementById('update-notifier-version');
        const d = document.getElementById('update-notifier-date');
        const c = document.getElementById('update-notifier-content');
        if (v) v.textContent = 'v' + CONFIG.version;
        if (d) d.textContent = CONFIG.buildDate;
        if (c) c.innerHTML = (notes || []).map((n) => `<li>${n}</li>`).join('');
        el.classList.add('visible');
      }
      return true;
    }
  }

  /* ===========================================================================
   * 11. ANTI-TRACKING GUARD  (EON index.html — bllokon vpnapi/db-ip etj.)
   *    Instalohet sa më herët në boot.
   * ========================================================================= */
  function installAntiTracking() {
    const isBlocked = (urlValue) => {
      try {
        const host = new URL(urlValue, location.href).hostname.toLowerCase();
        return CONFIG.blockedHosts.some((d) => host === d || host.endsWith('.' + d));
      } catch { return false; }
    };
    const origFetch = global.fetch;
    global.fetch = function (...args) {
      const url = args[0]?.url || args[0];
      if (url && isBlocked(url)) { console.warn('[ONYX] Blocked fetch:', url); return Promise.reject('Blocked'); }
      return origFetch.apply(this, args);
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (url && isBlocked(url)) throw new Error('Blocked');
      return origOpen.call(this, method, url, ...rest);
    };
    if (navigator.sendBeacon) {
      const origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => (url && isBlocked(url)) ? false : origBeacon(url, data);
    }
  }

  /* ===========================================================================
   * 12. BOOT  (HAPJA — EON key.js: verifikim licence → ngarko motorin → nis modulet)
   * ========================================================================= */
  async function verifyLicense() {
    const key = localStorage.getItem(CONFIG.licenseKeyStorage);
    if (!key) throw new Error('No key found');
    const res = await fetch(CONFIG.licenseVerifyUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Invalid key');
    return true;
  }

  async function boot(opts = {}) {
    installAntiTracking();

    const bus = new EventBus();
    const store = new SettingsStore();
    const engine = new EngineAdapter(bus);

    // 1) Verifikim licence (mund të kapërcehet në dev me opts.skipLicense)
    if (!opts.skipLicense) {
      try { await verifyLicense(); }
      catch (e) {
        document.documentElement.innerHTML =
          '<h1 style="text-align:center;margin-top:100px;font-family:sans-serif">Access denied</h1>';
        throw e;
      }
    }

    // 2) Ngarko motorin WASM (@requires engine — lidhe me wasmLoader.js real)
    await engine.loadWasm(opts.wasmUrl);

    // 3) Ndërto modulet
    const multibox = new MultiboxController(bus, engine);
    const replay = new ReplayRecorder();
    const chat = new ChatClient(bus, multibox);
    const hotkeys = new HotkeyManager(bus, multibox, replay);
    const input = new InputRouter(bus, multibox, hotkeys);
    const profiles = new ProfileManager(store);
    const updates = new UpdateNotifier(store);

    // 4) Lidhjet ndër-modul
    bus.on('multibox:toggleRing', () => {
      CONFIG.multibox.ringType = CONFIG.multibox.ringType === 'off' ? 'thin' : 'off';
    });

    // 5) Ekspozo API publike në një namespace të vetëm (zgjidh konfliktet globale)
    const api = {
      version: CONFIG.version, config: CONFIG, bus, engine,
      multibox, chat, replay, hotkeys, input, settings: store, profiles, updates,
      Protocol: { Writer, Reader }, OP,
      /** Nis një lojë multibox me profilin aktual */
      play(profileOverride) {
        const p = profileOverride || profiles.current();
        const playBtn = typeof document !== 'undefined' && document.getElementById('button-play');
        if (playBtn) {
          playBtn.click();
          return api;
        }
        if (global.SC && typeof global.SC.init === 'function') {
          const host = (p && (p.server || p.host)) || CONFIG.defaultServer;
          global.SC.init(host, 1);
        }
        return api;
      },
      stop() {
        if (global.SC && typeof global.SC.disconnect === 'function') {
          try { global.SC.disconnect(1); } catch (_) {}
          try { global.SC.disconnect(2); } catch (_) {}
        }
        multibox.disconnect(); input.detach(); replay.dispose();
      },
    };

    // pajtueshmëri me chat.js origjinal që pret window.multibox.clients
    global.multibox = multibox;
    global.OnyxReplay = replay;
    global.__onyxBus = bus;

    updates.maybeShow(['Skript i unifikuar ONYX/EON/SENPA', 'Multibox dual-connection i ripunuar']);
    bus.emit('boot:ready', api);
    return api;
  }

  /* ===========================================================================
   * 13. EXPORT
   * ========================================================================= */
  const ONYX = {
    boot, CONFIG,
    EventBus, Writer, Reader, EngineAdapter,
    MultiboxController, MultiboxClient, InputRouter, HotkeyManager,
    ChatClient, ReplayRecorder, SettingsStore, ProfileManager, UpdateNotifier,
    installAntiTracking, verifyLicense,
  };
  global.ONYX = ONYX;
  if (typeof module !== 'undefined' && module.exports) module.exports = ONYX;
})(typeof window !== 'undefined' ? window : globalThis);
