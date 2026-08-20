/**
 * ONYX FFA client.
 *
 * index.html → onyx-ffa.js → isolated codec worker (bundle.wasm) → wss://eu.senpa.io:2001
 *
 * Jaxx/og is protocol source only. The Jaxx lobby, bundle.js app, iframe, and
 * page-global WebSocket hook must not run next to deo.onyx.beautified.js.
 */
(function (global) {
  'use strict';

  var FFA_ID = 'delta-ffaeu2';
  var FFA_VALUE = 'delta-ffaeu2';
  var FFA_TYPE = 'ffa';
  var FFA_HOST = 'eu.senpa.io:2001';
  var FFA_WS = 'wss://eu.senpa.io:2001';
  var LEGACY_HOSTS = /(?:eu\.mi\.com:2001|(?:eu1|us|dual|mega)\.senpa\.io:(?:2001|2002|1200|9999|4002))/;
  var AUTH_ORIGIN = 'https://api.senpa.io';
  var SESSION_KEY = 'senpaio:session';
  var TOKEN_KEY = 'senpa_auth_token';
  var TID_KEY = '__ONYX_FFA_TID__';
  var CAPTCHA_SITE_KEY = '0x4AAAAAAACWFDYFT_opGqX8';
  var WORKER_URL = null;

  var playing = false;
  var lastPhase = 'IDLE';
  var worker = null;
  var workerReady = false;
  var socketOpen = false;
  var authCompleted = false;
  var guestHandshakeSent = false;
  var clientReady = false;
  var worldSeen = false;
  var spawned = false;
  var pingTimer = null;
  var spawnTimer = null;
  var clientId = 0;
  var playerIds = [];
  var activeTab = 0;
  var cells = Object.create(null);
  var ownCells = [];
  var players = Object.create(null);
  var playerClients = Object.create(null);
  var spawnSent = false;
  var spawnPidLogs = 0;
  var spawnAttempts = 0;
  var inboundLogs = 0;
  var syncRequested = false;
  var identityReady = false;
  var spectateEnabled = false;
  var spectateX = 0;
  var spectateY = 0;
  var seenKind0 = [];
  var spawnWaitTimer = null;
  var cursorTimer = null;
  var lastNick = 'player';
  var lastTag = '';
  var wantSpectate = false;
  var playRequested = false;
  var spawnReadyTimer = null;
  var pingMs = 0;
  var pingSentAt = 0;
  var fpsFrames = 0;
  var fpsLast = 0;
  var fpsValue = 0;
  var lastLeaderboardAt = 0;
  var camX = 0;
  var camY = 0;
  var camZoom = 0.18;
  var skinCache = Object.create(null);
  var border = 0;
  var mouseX = 0;
  var mouseY = 0;
  var rafId = 0;
  var turnstilePending = false;

  function log(msg) {
    console.log('[FFA]', msg);
  }

  function setPhase(name) {
    lastPhase = name;
    console.log('[ONYX]', name);
  }

  function logAuth(msg) { console.log('[AUTH]', msg); }
  function logCodec(msg) { console.log('[CODEC]', msg); }
  function logWs(msg) { console.log('[WS]', msg); }
  function logHandshake(msg) { console.log('[HANDSHAKE]', msg); }
  function logInit(msg) { console.log('[INIT]', msg); }
  function logWorld(msg) { console.log('[WORLD]', msg); }
  function logSpawn(msg) { console.log('[SPAWN]', msg); }
  function logGame(msg) { console.log('[GAME]', msg); }

  function fail(code, msg, extra) {
    setPhase(code);
    console.error('[FFA ERROR]', code, msg || '');
    if (extra) console.error('[FFA ERROR]', extra);
    toast(code + (msg ? (': ' + msg) : ''), true);
  }

  function toast(text, isError) {
    try {
      var el = document.getElementById('onyx-ffa-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'onyx-ffa-status';
        el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;padding:8px 14px;border-radius:8px;font:600 12px/1.4 Segoe UI,system-ui,sans-serif;pointer-events:none;max-width:min(720px,92vw);text-align:center';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.background = isError ? 'rgba(90,20,20,.92)' : 'rgba(12,22,18,.92)';
      el.style.color = isError ? '#ffb4b4' : '#b7f0c8';
      el.style.display = 'block';
    } catch (_) {}
  }

  function snapshotGlobals(label) {
    try {
      log('globals ' + label + ' Module=' + (typeof global.Module) +
        ' WebSocket=' + ((global.WebSocket && global.WebSocket.name) || typeof global.WebSocket) +
        ' hooked=' + !!(global.WebSocket && global.WebSocket.__onyxFfaHook) +
        ' app=' + (typeof global.app) +
        ' Client=' + (typeof global.Client) +
        ' Connection=' + (typeof global.Connection));
    } catch (_) {}
  }

  function isFfaValue(value) {
    if (!value) return false;
    if (typeof value === 'object') {
      if (value.type === FFA_TYPE || value.id === FFA_ID) return true;
      value = value.value || value.host || value.wsUrl || '';
    }
    var v = String(value);
    if (v === FFA_VALUE || v === FFA_ID || v === FFA_HOST || v === FFA_WS) return true;
    if (v.indexOf('ffa:') === 0) return true;
    if (v.indexOf('eu.senpa.io:2001') !== -1) return true;
    return false;
  }

  function selectedOption() {
    var sel = document.getElementById('servers');
    if (!sel) return null;
    return sel.options[sel.selectedIndex] || null;
  }

  function selectedServer() {
    var sel = document.getElementById('servers');
    return sel ? sel.value : '';
  }

  function ensureDeltaSelected() {
    var sel = document.getElementById('servers');
    if (!sel || !sel.options || !sel.options.length) return false;
    var current = selectedOption();
    if (current && (current.getAttribute('data-onyx-type') === FFA_TYPE || isFfaValue(sel.value))) return true;
    var candidate = null;
    for (var i = 0; i < sel.options.length; i++) {
      var opt = sel.options[i];
      var marker = [opt.getAttribute('data-onyx-type') || '', opt.getAttribute('data-onyx-host') || '', opt.getAttribute('data-onyx-id') || '', opt.textContent || ''].join(' ').toLowerCase();
      if (marker.indexOf('eu.senpa.io:2001') !== -1 || marker.indexOf('delta-ffaeu2') !== -1 || marker.indexOf('delta ffaeu2') !== -1) {
        candidate = opt;
        break;
      }
    }
    if (!candidate) return false;
    if (candidate.getAttribute('data-onyx-host')) candidate.value = candidate.getAttribute('data-onyx-host');
    sel.selectedIndex = candidate.index;
    try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    log('CONNECT', 'auto-selected Delta FFAEU2 option host=' + sel.value);
    return true;
  }

  function isUserscriptRuntime() {
    return !!(global.__KATERONYX_USERSCRIPT__ || /(?:^|\.)senpa\.io$/.test(location.hostname));
  }

  function isFfaSelected() {
    // The legacy UI can leave the only Delta option at selectedIndex=-1.
    // Re-select it at the exact moment PLAY is tested, not only during boot.
    if (!selectedOption()) ensureDeltaSelected();
    if (isUserscriptRuntime()) return true;
    var opt = selectedOption();
    if (opt && opt.getAttribute('data-onyx-type') === FFA_TYPE) return true;
    if (opt) {
      var marker = [
        opt.getAttribute('data-onyx-id') || '',
        opt.getAttribute('data-onyx-host') || '',
        opt.getAttribute('value') || '',
        opt.textContent || ''
      ].join(' ').toLowerCase();
      if (marker.indexOf('delta-ffaeu2') !== -1 ||
          marker.indexOf('eu.senpa.io:2001') !== -1 ||
          marker.indexOf('delta ffaeu2') !== -1) return true;
    }
    return isFfaValue(selectedServer());
  }

  function sanitizeLegacyServerStore() {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      var raw = localStorage.getItem(key);
      if (!raw || !LEGACY_HOSTS.test(raw)) continue;
      try {
        var obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && obj.server && LEGACY_HOSTS.test(String(obj.server))) {
          obj.server = FFA_VALUE;
          localStorage.setItem(key, JSON.stringify(obj));
        }
      } catch (_) {}
    }
    try {
      if (LEGACY_HOSTS.test(localStorage.getItem('ZYNX:server') || '')) {
        localStorage.setItem('ZYNX:server', FFA_VALUE);
      }
    } catch (_) {}
  }
    try { sanitizeLegacyServerStore(); } catch (_) {}

  document.addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel || sel.id !== 'servers') return;
    var opt = sel.options[sel.selectedIndex];
    var ffa = (opt && opt.getAttribute('data-onyx-type') === FFA_TYPE) || isFfaValue(sel.value);
    if (ffa) {
      e.stopImmediatePropagation();
      return;
    }
    if (playing) stop('switch-legacy');
  }, true);

  function normalizeToken(raw) {
    return String(raw || '').trim().replace(/^["']|["']$/g, '');
  }

  function decodeJwtPayload(token) {
    var parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function isJwtValid(token) {
    var t = normalizeToken(token);
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) return false;
    var data = decodeJwtPayload(t);
    if (!data) return false;
    if (data.exp && data.exp * 1000 <= Date.now()) return false;
    return true;
  }

  function readToken() {
    var session = '';
    var pasted = '';
    try { session = normalizeToken(localStorage.getItem(SESSION_KEY)); } catch (_) {}
    try { pasted = normalizeToken(localStorage.getItem(TOKEN_KEY)); } catch (_) {}
    if (isJwtValid(session)) return session;
    if (isJwtValid(pasted)) return pasted;
    return '';
  }

  function tokenProblem() {
    var session = '';
    var pasted = '';
    try { session = normalizeToken(localStorage.getItem(SESSION_KEY)); } catch (_) {}
    try { pasted = normalizeToken(localStorage.getItem(TOKEN_KEY)); } catch (_) {}
    var any = session || pasted;
    if (!any) return 'TOKEN_MISSING';
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(any)) return 'TOKEN_MISSING';
    var data = decodeJwtPayload(any);
    if (data && data.exp && data.exp * 1000 <= Date.now()) return 'TOKEN_EXPIRED';
    if (!isJwtValid(any)) return 'TOKEN_MISSING';
    return null;
  }

  function saveToken(token) {
    var t = normalizeToken(token);
    if (!isJwtValid(t)) return false;
    try { localStorage.setItem(SESSION_KEY, t); } catch (_) {}
    try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
    if (global.ONYXAuth && typeof global.ONYXAuth.login === 'function') {
      try { global.ONYXAuth.login(t); } catch (_) {}
    }
    return true;
  }

  function openSenpaLogin() {
    log('Starting authentication');
    toast('Opening Senpa login…');
    var popup = window.open(
      AUTH_ORIGIN + '/auth/discord',
      'Senpa Discord Login',
      'toolbar=no,menubar=no,width=600,height=700,top=100,left=100'
    );
    if (!popup) {
      fail('AUTH_REQUIRED', 'Popup blocked. Allow popups, or paste a Senpa session token.');
      if (global.ONYXAuth && global.ONYXAuth.openSenpaPanel) global.ONYXAuth.openSenpaPanel();
      return null;
    }
    try { popup.focus(); } catch (_) {}
    return popup;
  }

  function waitForAuth(timeoutMs) {
    timeoutMs = timeoutMs || 180000;
    return new Promise(function (resolve, reject) {
      var existing = readToken();
      if (existing) {
        saveToken(existing);
        resolve(existing);
        return;
      }
      openSenpaLogin();
      var timer = setTimeout(function () {
        cleanup();
        var problem = tokenProblem() || 'AUTH_REQUIRED';
        fail(problem, 'Login did not finish.');
        reject(new Error(problem));
      }, timeoutMs);

      function onMessage(event) {
        if (event.origin !== AUTH_ORIGIN) return;
        var data = event.data || {};
        if (data.type === 'senpa-auth-ready') {
          try { event.source && event.source.postMessage({ type: 'senpa-auth-hello' }, AUTH_ORIGIN); } catch (_) {}
          return;
        }
        var token = data.access_token || data.token;
        if (token && saveToken(token)) {
          cleanup();
          resolve(token);
        }
      }

      function onUpdated() {
        var token = readToken();
        if (token) {
          cleanup();
          resolve(token);
        }
      }

      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        window.removeEventListener('senpa-auth-updated', onUpdated);
        window.removeEventListener('onyx:senpa-auth-changed', onUpdated);
      }

      window.addEventListener('message', onMessage);
      window.addEventListener('senpa-auth-updated', onUpdated);
      window.addEventListener('onyx:senpa-auth-changed', onUpdated);
    });
  }

  function readUiProfile() {
    var nickEl = document.getElementById('nick');
    var tagEl = document.getElementById('tag');
    var nick = ((nickEl && nickEl.value) || lastNick || 'player').trim() || 'player';
    var tag = ((tagEl && tagEl.value) || lastTag || '').trim();
    if (nick.length > 32) nick = nick.substring(0, 32);
    if (tag.length > 5) tag = tag.substring(0, 5);
    lastNick = nick;
    lastTag = tag;
    try { localStorage.setItem('kateronyx:nick', nick); } catch (_) {}
    try { localStorage.setItem('kateronyx:tag', tag); } catch (_) {}
    return {
      nick1: nick,
      nick2: (document.getElementById('nick2') || {}).value || '',
      tag: tag,
      skin1: (document.getElementById('skin') || {}).value || '',
      skin2: (document.getElementById('skin2') || {}).value || ''
    };
  }

  function Writer(size) {
    this.le = true;
    this.offset = 0;
    this.buffer = new ArrayBuffer(size || 8192);
    this.view = new DataView(this.buffer);
  }
  Writer.prototype.writeUInt8 = function (v) { this.view.setUint8(this.offset++, v); };
  Writer.prototype.writeUInt16 = function (v) { this.view.setUint16(this.offset, v, this.le); this.offset += 2; };
  Writer.prototype.writeInt32 = function (v) { this.view.setInt32(this.offset, v, this.le); this.offset += 4; };
  Writer.prototype.writeUTF16String = function (t) {
    t = String(t || '');
    for (var i = 0; i < t.length; i++) this.writeUInt16(t.charCodeAt(i));
  };
  Writer.prototype.writeUTF16StringLength = function (t) {
    t = String(t || '');
    if (t.length > 255) t = t.substring(0, 255);
    this.writeUInt8(t.length);
    this.writeUTF16String(t);
  };
  Writer.prototype.writeLongString8 = function (t) {
    t = String(t || '');
    this.writeUInt16(t.length);
    for (var i = 0; i < t.length; i++) this.writeUInt8(t.charCodeAt(i));
  };
  Writer.prototype.finalize = function () {
    return new Uint8Array(this.buffer.slice(0, this.offset));
  };

  function Reader(view) {
    this.view = view;
    this.offset = 0;
    this.le = true;
  }
  Reader.prototype.readUInt8 = function () { return this.view.getUint8(this.offset++); };
  Reader.prototype.readInt8 = function () { return this.view.getInt8(this.offset++); };
  Reader.prototype.readUInt16 = function () { var v = this.view.getUint16(this.offset, this.le); this.offset += 2; return v; };
  Reader.prototype.readUInt24 = function () { return this.readUInt8() << 16 | this.readUInt8() << 8 | this.readUInt8(); };
  Reader.prototype.readUInt32 = function () { var v = this.view.getUint32(this.offset, this.le); this.offset += 4; return v; };
  Reader.prototype.readInt32 = function () { var v = this.view.getInt32(this.offset, this.le); this.offset += 4; return v; };
  Reader.prototype.readUTF16String = function (len) {
    var n = '';
    for (var i = 0; i < len; i++) n += String.fromCharCode(this.readUInt16());
    return n;
  };
  Reader.prototype.readUTF16StringLength = function () {
    return this.readUTF16String(this.readUInt8());
  };
  Reader.prototype.readUTF8String = function (len) {
    var n = '';
    for (var i = 0; i < len; i++) n += String.fromCharCode(this.readUInt8());
    return n;
  };
  Reader.prototype.readUTF8StringLength = function () {
    return this.readUTF8String(this.readUInt8());
  };

  function tid() {
    var existing = '';
    try { existing = global.__JAXXV6_SENPA_TID__ || sessionStorage.getItem(TID_KEY) || ''; } catch (_) {}
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
    var hex;
    if (typeof crypto.randomUUID === 'function') hex = crypto.randomUUID().replace(/-/g, '');
    else {
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      hex = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    try { global.__JAXXV6_SENPA_TID__ = hex; sessionStorage.setItem(TID_KEY, hex); } catch (_) {}
    return hex;
  }

  function ffaHost() {
    var opt = selectedOption();
    var host = (opt && opt.getAttribute('data-onyx-host')) || FFA_HOST;
    if (!host || host.indexOf('ffa:') !== -1 || host.indexOf('://') !== -1) {
      throw new Error('[FFA] Invalid server host: ' + host);
    }
    return host;
  }

  function buildFfaUrl() {
    var host = ffaHost();
    var originHost = location.host;
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(originHost)) originHost = 'onyxdelta-5768.vercel.app';
    return 'wss://' + host + '?po=' + encodeURIComponent(originHost) + '&tid=' + tid();
  }

  function hexBytes(bytes, max) {
    var n = Math.min(bytes.length, max || 16);
    var out = [];
    for (var i = 0; i < n; i++) out.push(('0' + bytes[i].toString(16)).slice(-2));
    return out.join(' ');
  }

  function sendPacket(writer) {
    if (!socketOpen) return;
    var bytes = writer instanceof Uint8Array ? writer : writer.finalize();
    var op = bytes.length ? bytes[0] : -1;
    if (op === 13) log('TX opcode=13 length=' + bytes.length);
    else if (op === 0) log('TX opcode=0 length=' + bytes.length + ' bytes=' + hexBytes(bytes));
    else if (op !== 20 && op !== 30) log('TX opcode=' + op + ' length=' + bytes.length);
    if (global.ONYXFfaCodec) {
      global.ONYXFfaCodec.send(bytes);
      return;
    }
    if (!worker) return;
    var copy = bytes.slice().buffer;
    worker.postMessage({ type: 'send', data: copy }, [copy]);
  }

  function sendAuth() {
    if (guestHandshakeSent) return;
    guestHandshakeSent = true;
    lastPhase = 'HANDSHAKE';
    authCompleted = true;
    clientReady = true;
    identityReady = true;
    var guest = 'null';
    var w = new Writer(3 + guest.length * 2);
    w.writeUInt8(13);
    w.writeUInt16(guest.length);
    w.writeUTF16String(guest);
    logAuth('GUEST');
    log('Delta FFAEU2 guest handshake — opcode=13 payload=null (no JWT)');
    sendPacket(w);
    // Delta can accept the profile metadata before serverInfo; sending it here
    // removes the extra wait before opcode 10/11 names arrive.
    try { sendPlayerInfo(); } catch (_) {}
    // Wait for server opcode=0/serverInfo before sending spawn.
  }

  function sendPlayerInfo() {
    if (!authCompleted) return;
    var cfg = readUiProfile();
    var nick = cfg.nick1 || 'player';
    var tag = cfg.tag || '';
    log('NICK name="' + nick + '" tag="' + tag + '"');
    var n = new Writer(4 + nick.length * 2);
    n.writeUInt8(10);
    n.writeUTF16StringLength(nick);
    sendPacket(n);
    var t = new Writer(4 + tag.length * 2);
    t.writeUInt8(11);
    t.writeUTF16StringLength(tag);
    sendPacket(t);
  }

  function sendPing() {
    if (!authCompleted) return;
    pingSentAt = Date.now();
    var w = new Writer(4);
    w.writeUInt8(30);
    sendPacket(w);
  }

  function sendFullSync() {
    if (!authCompleted || syncRequested) return;
    syncRequested = true;
    var w = new Writer(2);
    w.writeUInt8(31);
    sendPacket(w);
    log('FULL_SYNC requested (missing cell in opcode 20 update)');
  }

  function flushWasmAlloc() {
    var codec = global.ONYXFfaCodec;
    if (!codec || typeof codec.alloc !== 'function') return;
    try {
      var track = global.CanvasCaptureMediaStreamTrack;
      if (track && track.contextBufferFactory) {
        var ok = codec.alloc(9, track.contextBufferFactory);
        track.contextBufferFactory = null;
        log('ALLOC 9 contextBufferFactory ok=' + !!ok);
      }
    } catch (err) {
      console.error('[FFA ERROR] ALLOC_9', err && err.message ? err.message : err);
    }
  }

  function armSpawnRetries() {
    if (spawnReadyTimer) return;
    spawnReadyTimer = setInterval(function () {
      if (!playing || spawned || wantSpectate || !playRequested) {
        clearInterval(spawnReadyTimer);
        spawnReadyTimer = null;
        return;
      }
      if (spawnAttempts >= 8) {
        clearInterval(spawnReadyTimer);
        spawnReadyTimer = null;
        return;
      }
      sendSpawn(true);
    }, 400);
  }

  function maybeSpawn() {
    if (!playRequested || wantSpectate || spawned) return;
    if (!authCompleted) return;
    if (!spawnSent) sendSpawn(false);
    armSpawnRetries();
  }

  function sendSpawn(isRetry) {
    if (!authCompleted || spawned) return;
    if (wantSpectate || !playRequested) return;
    spectateEnabled = false;
    if (!mouseX && !mouseY && border) {
      mouseX = (border / 2) | 0;
      mouseY = (border / 2) | 0;
    }
    sendPlayerInfo();
    sendCursor();
    var w = new Writer(4);
    w.writeUInt8(0);
    w.writeUInt8(activeTab);
    spawnSent = true;
    spawnAttempts++;
    lastPhase = 'SPAWN';
    logSpawn('name="' + lastNick + '" opcode=0 tab=' + activeTab + ' playerId=' + (playerIds[0] || 0) + ' clientId=' + clientId + ' spectate=0 retry=' + !!isRetry + ' attempt=' + spawnAttempts);
    log('SPAWN name="' + lastNick + '"');
    log('SPAWN opcode=0 tab=' + activeTab);
    log('SPAWN playerId=' + (playerIds[0] || 0) + ' clientId=' + clientId);
    log('SPAWN cursor=play');
    log('SPAWN waiting for own cell...');
    log('Sending spawn for tab ' + activeTab);
    log('SPAWN_SENT');
    setPhase('SPAWNING');
    sendPacket(w);
    if (spawnWaitTimer) clearTimeout(spawnWaitTimer);
    spawnWaitTimer = setTimeout(function () {
      if (spawned || !playing) return;
      spawnSent = false;
      playRequested = false;
      if (spawnReadyTimer) { clearInterval(spawnReadyTimer); spawnReadyTimer = null; }
      fail('SPAWN_FAILED', 'reason=no own kind-0 cell last opcode=20 playerId=' + (playerIds[0] || 0) + ' clientId=' + clientId + ' seenKind0=' + seenKind0.join(',') + ' attempts=' + spawnAttempts + '. Close other senpa.io tabs, then PLAY again.');
      if (global.ONYXUi && global.ONYXUi.showMenu) global.ONYXUi.showMenu();
    }, 8000);
  }

  function sendCursor() {
    if (!authCompleted) return;
    var w = new Writer(16);
    w.writeUInt8(20);
    if (spectateEnabled && !spawned) {
      w.writeUInt8(1);
    } else {
      w.writeUInt8(0);
      w.writeUInt8(activeTab);
    }
    w.writeInt32(mouseX | 0);
    w.writeInt32(mouseY | 0);
    sendPacket(w);
  }

  function sendSplit() {
    if (!authCompleted) return;
    var w = new Writer(8);
    w.writeUInt8(22);
    w.writeUInt8(activeTab);
    w.writeUInt8(1);
    sendPacket(w);
  }

  function sendFeed() {
    if (!authCompleted) return;
    var w = new Writer(8);
    w.writeUInt8(23);
    w.writeUInt8(activeTab);
    w.writeUInt8(0);
    sendPacket(w);
  }

  function sendCaptcha(type, token) {
    var w = new Writer(8 + String(token || '').length);
    w.writeUInt8(14);
    w.writeUInt8(type);
    w.writeLongString8(token);
    sendPacket(w);
  }

  function markConnected() {
    if (spawned) return;
    spawned = true;
    lastPhase = 'CONNECTED';
    global.__ONYX_FFA_CONNECTED__ = true;
    if (spawnTimer) { clearInterval(spawnTimer); clearTimeout(spawnTimer); spawnTimer = null; }
    if (spawnWaitTimer) { clearTimeout(spawnWaitTimer); spawnWaitTimer = null; }
    if (spawnReadyTimer) { clearInterval(spawnReadyTimer); spawnReadyTimer = null; }
    spectateEnabled = false;
    logSpawn('CONFIRMED');
    log('OWN CELL DETECTED');
    log('playerId=' + (ownCells.length && cells[ownCells[0]] ? cells[ownCells[0]].pid : playerIds[0]));
    log('cellId=' + (ownCells[0] || 0));
    log('kind=0');
    log('Spawn successful');
    log('SPAWN_CONFIRMED');
    log('SPAWN_SUCCESS');
    log('FFA CONNECTED');
    log('FFA_CONNECTED');
    log('CONNECTED');
    logGame('READY');
    setPhase('IN_GAME');
    toast('FFA CONNECTED');
    setAliveHud();
    if (global.ONYXUi && global.ONYXUi.hideMenu) global.ONYXUi.hideMenu();
    if (global.ONYXUi && global.ONYXUi.setStatus) global.ONYXUi.setStatus('● ONYX in game');
  }

  function tabPlayerId() {
    return playerIds.length ? playerIds[0] : 0;
  }

  function isOwnPlayerId(pid) {
    if (!pid && pid !== 0) return false;
    // Delta guest may intentionally use zero IDs and omit playerIds.
    // Claim the first kind-0 cell after our spawn when no identity mapping exists.
    var noGuestIdentity = clientId === 0 && (playerIds.length === 0 || (playerIds.length === 1 && playerIds[0] === 0));
    if (playRequested && !spawned && ownCells.length === 0 && noGuestIdentity) {
      log('Guest fallback: claiming first kind-0 cell without identity mapping pid=' + pid);
      return true;
    }
    if (playerIds.indexOf(pid) !== -1) return true;
    if (tabPlayerId() && pid === tabPlayerId()) return true;
    if (clientId && pid === clientId) return true;
    var rec = players[pid];
    if (rec) {
      if (clientId && rec.clientId === clientId) return true;
      if (playerIds.indexOf(rec.clientId) !== -1) return true;
    }
    return false;
  }

  function claimOwnCell(id, pid) {
    var cell = cells[id];
    if (!cell) return;
    cell.mine = true;
    cell.pid = pid || cell.pid || 0;
    if (ownCells.indexOf(id) === -1) ownCells.push(id);
    markConnected();
  }

  function adoptOwnCellsFromWorld() {
    if (spawned) return;
    var ids = Object.keys(cells);
    var firstKind0 = null;
    for (var i = 0; i < ids.length; i++) {
      var cell = cells[ids[i]];
      if (!cell || cell.kind !== 0) continue;
      if (!firstKind0) firstKind0 = cell;
      if (isOwnPlayerId(cell.pid)) {
        claimOwnCell(cell.id, cell.pid);
        return;
      }
    }
    // Delta can send parentClientID values that are not the serverInfo playerIds.
    // Once identity is ready, claim the first live kind-0 cell as the guest cell.
    if (firstKind0 && playRequested && identityReady) {
      log('Delta guest fallback: claiming first kind-0 cell after identity map');
      claimOwnCell(firstKind0.id, firstKind0.pid);
    }
  }

  function handleOpcode10(r) {
    var start = r.offset;
    try {
      var add = r.readUInt8();
      var i;
      for (i = 0; i < add; i++) {
        var id = r.readUInt16();
        var isBot = !!r.readUInt8();
        var nick = r.readUTF16StringLength();
        var tag = r.readUTF16StringLength();
        var red = r.readUInt8();
        var green = r.readUInt8();
        var blue = r.readUInt8();
        var reserved = !!r.readUInt8();
        var color = (red << 16) | (green << 8) | blue;
        // Delta opcode 10 has no clan field in the add record.
        playerClients[id] = { clientId: id, isBot: isBot, nick: nick, name: nick, tag: tag, color: color, reserved: reserved };
      }
      var upd = r.readUInt8();
      for (i = 0; i < upd; i++) {
        var uid = r.readUInt16();
        var flags = r.readUInt8();
        var row = playerClients[uid];
        if (flags & 1) {
          var nn = r.readUTF16StringLength();
          if (row) { row.nick = nn; row.name = nn; }
        }
        if (flags & 2) {
          var tg = r.readUTF16StringLength();
          if (row) row.tag = tg;
        }
        if (flags & 4) {
          var ur = r.readUInt8();
          var ug = r.readUInt8();
          var ub = r.readUInt8();
          var res = !!r.readUInt8();
          if (row) { row.color = (ur << 16) | (ug << 8) | ub; row.reserved = res; }
        }
        // Delta opcode 10 has no flags&8 clan payload.
      }
      var del = r.readUInt8();
      for (i = 0; i < del; i++) delete playerClients[r.readUInt16()];
      refreshCellNames();
      updateFfaLeaderboard();
    } catch (err) {
      log('opcode10 skipped safely at offset=' + start + ' error=' + (err && err.message || err));
    }
  }

  function handleOpcode11(r) {
    var add = r.readUInt8();
    var i;
    for (i = 0; i < add; i++) {
      var pid = r.readUInt16();
      var cid = r.readUInt16();
      var color = r.readUInt24();
      var skin = r.readUTF8StringLength();
      players[pid] = { playerId: pid, clientId: cid, color: color, skin: skin };
      if (isOwnPlayerId(pid) || (clientId && cid === clientId) || (playerIds.indexOf(cid) !== -1)) {
        identityReady = true;
        log('opcode11 map pid=' + pid + ' clientId=' + cid + ' own=true');
        log('IDENTITY_READY');
      } else if (spawnSent && !spawned && spawnPidLogs < 12) {
        log('opcode11 map pid=' + pid + ' clientId=' + cid + ' own=false');
      }
    }
    var upd = r.readUInt8();
    for (i = 0; i < upd; i++) {
      var upid = r.readUInt16();
      var uflags = r.readUInt8();
      var prow = players[upid];
      if (uflags & 1) {
        var ucol = r.readUInt24();
        if (prow) prow.color = ucol;
      }
      if (uflags & 2) {
        var uskin = r.readUTF8StringLength();
        if (prow) prow.skin = uskin;
      }
    }
    var del = r.readUInt8();
    for (i = 0; i < del; i++) delete players[r.readUInt16()];
    refreshCellNames();
    updateFfaLeaderboard();
    adoptOwnCellsFromWorld();
    if (playRequested && authCompleted && !spawned) maybeSpawn();
  }

  function handleOpcode20(r) {
    var eatCount = r.readUInt16();
    var i;
    for (i = 0; i < eatCount; i++) {
      r.readUInt32();
      var eatenId = r.readUInt32();
      delete cells[eatenId];
    }
    var addCount = r.readUInt16();
    for (i = 0; i < addCount; i++) {
      var id = r.readUInt32();
      var x = r.readInt32();
      var y = r.readInt32();
      var size = r.readUInt16();
      var kind = r.readUInt8();
      var mine = false;
      var color = 0xffffff;
      var pid = 0;
      if (kind === 0) {
        pid = r.readUInt16();
        color = r.readUInt24();
        mine = isOwnPlayerId(pid);
        if (seenKind0.indexOf(pid) === -1) seenKind0.push(pid);
        if (spawnSent && !spawned && spawnPidLogs < 16) {
          spawnPidLogs++;
          log('opcode20 kind0 pid=' + pid + ' own=' + mine + ' playerIds=' + playerIds.join(',') + ' clientId=' + clientId);
        }
      } else if (kind === 2) {
        color = r.readUInt24();
      } else if (kind === 5) {
        var blobLen = r.readUInt16();
        var blob = new Uint8Array(blobLen);
        for (var bi = 0; bi < blobLen; bi++) blob[bi] = r.readUInt8();
        if (global.ONYXFfaCodec && global.ONYXFfaCodec.alloc) {
          var ok = global.ONYXFfaCodec.alloc(8, blob.slice ? blob.slice() : blob);
          log('ALLOC 8 blob=' + blobLen + ' ok=' + !!ok);
        }
      }
      var cellRec = players[pid];
      var cellClient = cellRec ? playerClients[cellRec.clientId] : playerClients[pid];
      cells[id] = { id: id, x: x, y: y, r: size, tx: x, ty: y, tr: size, mine: mine, color: color, kind: kind, pid: pid, clientId: cellRec ? cellRec.clientId : pid, nick: cellClient ? (cellClient.nick || cellClient.name || '') : '', tag: cellClient ? (cellClient.tag || '') : '', skin: (cellRec && cellRec.skin) || '' };
      if (mine) claimOwnCell(id, pid);
    }
    var updCount = r.readUInt16();
    for (i = 0; i < updCount; i++) {
      var uid = r.readUInt32();
      var ux = r.readInt32();
      var uy = r.readInt32();
      var ur = r.readUInt16();
      if (cells[uid]) {
        cells[uid].tx = ux;
        cells[uid].ty = uy;
        cells[uid].tr = ur;
        if (cells[uid].mine) markConnected();
      } else if (!syncRequested) {
        sendFullSync();
      }
    }
    var delCount = r.readUInt16();
    for (i = 0; i < delCount; i++) {
      var did = r.readUInt32();
      if (did === 0) break;
      delete cells[did];
      var idx = ownCells.indexOf(did);
      if (idx !== -1) ownCells.splice(idx, 1);
    }
    var stillOwn = false;
    var liveIds = Object.keys(cells);
    for (var zi = 0; zi < liveIds.length; zi++) {
      if (cells[liveIds[zi]] && cells[liveIds[zi]].mine && cells[liveIds[zi]].kind === 0) {
        stillOwn = true;
        break;
      }
    }
    if (spawned && !stillOwn) {
      spawned = false;
      spawnSent = false;
      playRequested = false;
      spectateEnabled = false;
      ownCells = [];
      logGame('DIED');
      setAliveHud();
      if (global.ONYXUi && global.ONYXUi.showMenu) global.ONYXUi.showMenu();
    }
    if (r.offset + 1 <= r.view.byteLength) r.readUInt8();
    if (r.offset + 4 <= r.view.byteLength) r.readUInt32();
    flushWasmAlloc();
    // Resolve names immediately when a new world cell is created. Delta may
    // deliver opcode 20 before opcode 10/11, so the next packet must repaint
    // the existing rows without waiting for another leaderboard cycle.
    refreshCellNames();
    updateFfaLeaderboard();
  }

  function handleOpcode21(r) {
    var rows = [];
    for (var n = r.readInt8(); n--;) {
      var cid = r.readUInt16();
      var score = r.readUInt32();
      var pc = playerClients[cid];
      rows.push({ name: (pc && pc.nick) || ('#' + cid), score: score });
    }
    rows.sort(function (a, b) { return b.score - a.score; });
    if (global.ONYXUi && global.ONYXUi.updateLeaderboard) global.ONYXUi.updateLeaderboard(rows);
  }

  function onServerPacket(buf) {
    var r = new Reader(new DataView(buf));
    if (r.view.byteLength < 1) return;
    var op = r.readUInt8();
    if (!spawned && inboundLogs < 40) {
      inboundLogs++;
      log('RX opcode=' + op + ' length=' + r.view.byteLength);
    }
    switch (op) {
      case 0: {
        border = r.readUInt32();
        clientId = r.readUInt16();
        var nTabs = r.readUInt8();
        playerIds = [];
        for (var t = 0; t < nTabs; t++) playerIds.push(r.readUInt16());
        if (playerIds.length > 1) {
          log('Delta dual mode accepted; using playerIds=' + playerIds.join(',') + ' with active Tab 1');
        }
        activeTab = 0;
        authCompleted = true;
        clientReady = true;
        identityReady = true;
        if (border) {
          mouseX = (border / 2) | 0;
          mouseY = (border / 2) | 0;
        }
        setPhase('INITIALIZING');
        logHandshake('ACCEPTED');
        logAuth('ACCEPTED');
        log('clientId=' + clientId + ' playerIds=' + (playerIds.join(',') || '(empty)') + ' nTabs=' + nTabs);
        log('Handshake accepted');
        log('HANDSHAKE');
        log('Authentication accepted');
        log('AUTH_ACCEPTED');
        logInit('COMPLETE');
        log('Initialization complete');
        log('INITIALIZED');
        setPhase('INITIALIZED');
        sendPlayerInfo();
        spectateEnabled = !!wantSpectate;
        if (playRequested && !wantSpectate) maybeSpawn();
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(sendPing, 1000);
        if (cursorTimer) clearInterval(cursorTimer);
        cursorTimer = setInterval(function () {
          if (playing && authCompleted) sendCursor();
        }, 50);
        break;
      }
      case 5: {
        setTimeHud(r.readUInt32() / 1000);
        break;
      }
      case 7: {
        r.readUInt8();
        var capType = r.readUInt8();
        log('Captcha requested type=' + capType);
        if (capType === 1) startTurnstile();
        else fail('SERVER_REJECTED', 'Unknown captcha type ' + capType);
        break;
      }
      case 8:
        setPhase('HANDSHAKE');
        logHandshake('SENT');
        sendAuth();
        break;
      case 10:
        handleOpcode10(r);
        if (lastPhase === 'INIT' || lastPhase === 'HANDSHAKE') log('Player initialized');
        break;
      case 11:
        handleOpcode11(r);
        if (lastPhase === 'INIT' || lastPhase === 'HANDSHAKE') log('Player initialized');
        break;
      case 20:
        if (!worldSeen) {
          worldSeen = true;
          logWorld('READY');
          log('World state received opcode=20');
          log('WORLD_READY');
          setPhase('WORLD_READY');
          if (playRequested && !wantSpectate && !spawned) maybeSpawn();
        }
        handleOpcode20(r);
        break;
      case 21:
        handleOpcode21(r);
        break;
      case 22:
        // Delta may emit split/control packets with a different payload shape.
        // Do not feed them into the opcode-20 cell parser.
        log('RX opcode=22 ignored safely (control/split payload)');
        break;
      case 15:
      case 41:
      case 42:
        break;
      case 23:
        spectateX = r.readInt32();
        spectateY = r.readInt32();
        if (!spawned && inboundLogs < 8) log('RX spectate camera x=' + spectateX + ' y=' + spectateY);
        break;
      case 30:
        if (pingSentAt) pingMs = Math.max(0, Date.now() - pingSentAt);
        break;
    }
  }

  function ensureTurnstile() {
    if (global.turnstile && typeof global.turnstile.render === 'function') {
      return Promise.resolve(global.turnstile);
    }
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]');
      if (!existing) {
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        script.async = true;
        script.defer = true;
        script.onerror = function () { reject(new Error('Turnstile script failed to load')); };
        (document.head || document.documentElement).appendChild(script);
      }
      var started = Date.now();
      (function poll() {
        if (global.turnstile && typeof global.turnstile.render === 'function') return resolve(global.turnstile);
        if (Date.now() - started > 15000) return reject(new Error('Turnstile did not load'));
        setTimeout(poll, 100);
      })();
    });
  }

  function startTurnstile() {
    if (turnstilePending) return;
    turnstilePending = true;
    ensureTurnstile().then(function (turnstile) {
      var overlay = document.getElementById('onyx-ffa-captcha');
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = 'onyx-ffa-captcha';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(0,0,0,.72);color:#eef4ff;font:16px system-ui,sans-serif';
      overlay.innerHTML = '<div style="width:min(92vw,430px);padding:24px;border:1px solid #3e516b;border-radius:14px;background:#111923;text-align:center"><h2 style="margin:0 0 10px">Security verification</h2><p>Complete Cloudflare verification to connect to Senpa FFA.</p><div id="onyx-ffa-turnstile"></div></div>';
      document.body.appendChild(overlay);
      turnstile.render('#onyx-ffa-turnstile', {
        sitekey: CAPTCHA_SITE_KEY,
        theme: 'dark',
        callback: function (token) {
          turnstilePending = false;
          sendCaptcha(1, token);
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        },
        'error-callback': function () {
          turnstilePending = false;
          fail('SERVER_REJECTED', 'Cloudflare verification failed');
          return true;
        }
      });
    }).catch(function (err) {
      turnstilePending = false;
      fail('INITIALIZATION_FAILED', err && err.message ? err.message : String(err));
    });
  }

  function showFfaCanvas(show, hideMenu) {
    var game = document.getElementById('gameCanvas');
    var legacy = document.getElementById('canvas');
    var menu = document.getElementById('menu-overlay');
    if (game) game.style.display = 'none';
    if (legacy) {
      legacy.style.display = 'block';
      legacy.style.visibility = 'visible';
      legacy.style.zIndex = '3';
      legacy.style.position = 'absolute';
      legacy.style.inset = '0';
    }
    if (menu) {
      if (!show) menu.style.display = 'block';
      else if (hideMenu) menu.style.display = 'none';
    }
    global.__ONYX_FFA_PLAYING__ = !!show;
    if (global.ONYXUi && global.ONYXUi.setStatus) {
      global.ONYXUi.setStatus(show ? (hideMenu ? '● ONYX' : '● ONYX connecting') : '● ONYX');
    }
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexColor(n) {
    return '#' + ('000000' + ((n >>> 0) & 0xffffff).toString(16)).slice(-6);
  }

  function readOnyxTheme() {
    var theme = {
      borderColor: '#e0a82e',
      borderGlow: '#ffcb3d',
      gridColor: '#1a1a20',
      nickColor: '#f5e6c8',
      nickStrokeColor: '#15100a',
      massColor: '#e0a82e',
      massStrokeColor: '#15100a',
      foodColor: '#e0a82e',
      foodGlow: '#ffcb3d',
      virusGlow: '#ffcb3d',
      virusBorderColor: '#e0a82e',
      backgroundColor: '#0e0e12',
      cursorLineColor: '#e0a82e',
      selfColor: '#e0a82e'
    };
    try {
      var stored = JSON.parse(localStorage.getItem('ONYXPROD540-theme') || '{}');
      for (var k in theme) if (stored[k]) theme[k] = stored[k];
    } catch (_) {}
    return theme;
  }

  function resolvePlayerClient(cell) {
    if (!cell) return null;
    var rec = players[cell.pid];
    var candidates = [];
    if (rec) candidates.push(rec.clientId, rec.playerId);
    candidates.push(cell.clientId, cell.pid);
    for (var i = 0; i < candidates.length; i++) {
      var key = candidates[i];
      if (key === undefined || key === null) continue;
      var pc = playerClients[key];
      if (pc && (pc.nick || pc.name || pc.tag)) return pc;
    }
    return null;
  }

  function cellName(cell) {
    var pc = resolvePlayerClient(cell);
    return (cell && (cell.nick || cell.name)) || (pc && (pc.nick || pc.name)) || '';
  }

  function refreshCellNames() {
    var ids = Object.keys(cells);
    for (var i = 0; i < ids.length; i++) {
      var cell = cells[ids[i]];
      if (!cell || cell.kind !== 0) continue;
      var pc = resolvePlayerClient(cell);
      if (pc && (pc.nick || pc.name)) cell.nick = pc.nick || pc.name;
      if (pc && pc.tag) cell.tag = pc.tag;
      if (cell.nick && cell.kind === 0) cell.__nameReadyAt = Date.now();
    }
  }

  function updateFfaLeaderboard() {
    var root = document.getElementById('leaderboard-positions');
    if (!root) return;
    var rows = root.querySelectorAll('.lb-position');
    if (!rows || !rows.length) return;
    var list = Object.keys(cells).map(function (id) { return cells[id]; }).filter(function (c) { return c && c.kind === 0; });
    list.sort(function (a, b) { return (b.r || 0) - (a.r || 0); });
    for (var i = 0; i < rows.length; i++) {
      var nameEl = rows[i].querySelector('[lbdata="name"]');
      if (!nameEl) continue;
      var cell = list[i];
      // A world packet can precede opcode 10/11. Keep the row blank until
      // the Delta client map resolves it instead of exposing a fake name.
      nameEl.textContent = cell ? (cellName(cell) || '') : '';
    }
  }

  function cellSkinUrl(cell) {
    if (cell.mine) {
      var mine = (document.getElementById('skin') || {}).value || '';
      if (mine) return mine;
    }
    var rec = players[cell.pid];
    return (cell.skin || (rec && rec.skin) || '').trim();
  }

  function getSkinImage(url) {
    if (!url || url.indexOf('http') !== 0) return null;
    var rec = skinCache[url];
    if (rec) return rec.ok ? rec.img : null;
    rec = skinCache[url] = { img: new Image(), ok: false, loading: true };
    rec.img.crossOrigin = 'anonymous';
    rec.img.onload = function () { rec.ok = true; rec.loading = false; };
    rec.img.onerror = function () { rec.ok = false; rec.loading = false; };
    rec.img.src = url;
    return null;
  }

  function drawVirus(ctx, x, y, r, theme) {
    var spikes = 18;
    ctx.beginPath();
    for (var i = 0; i < spikes; i++) {
      var a1 = (Math.PI * 2 * i) / spikes;
      var a2 = a1 + Math.PI / spikes;
      ctx.lineTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
      ctx.lineTo(x + Math.cos(a2) * (r * 0.72), y + Math.sin(a2) * (r * 0.72));
    }
    ctx.closePath();
    ctx.fillStyle = '#33c45a';
    ctx.shadowColor = theme.virusGlow;
    ctx.shadowBlur = Math.max(8, r * 0.18);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = theme.virusBorderColor;
    ctx.lineWidth = Math.max(3, r * 0.055);
    ctx.stroke();
  }

  function drawOnyxCell(ctx, cell, theme) {
    var x = cell.x;
    var y = cell.y;
    var r = Math.max(4, cell.r);
    if (cell.kind === 1) {
      drawVirus(ctx, x, y, r, theme);
      return;
    }
    if (cell.kind === 3) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = theme.foodColor;
      ctx.shadowColor = theme.foodGlow;
      ctx.shadowBlur = Math.max(6, r * 1.6);
      ctx.fill();
      ctx.shadowBlur = 0;
      return;
    }
    var fill = cell.mine ? theme.selfColor : hexColor(cell.color || 0xffffff);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = cell.kind === 2 ? 0.72 : 1;
    ctx.fillStyle = fill;
    ctx.fill();
    var skin = getSkinImage(cellSkinUrl(cell));
    if (skin) {
      ctx.globalAlpha = 0.94;
      ctx.drawImage(skin, x - r, y - r, r * 2, r * 2);
    }
    var grd = ctx.createRadialGradient(x - r * 0.28, y - r * 0.28, r * 0.08, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.22)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = cell.mine ? theme.borderColor : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(cell.mine ? 4 : 2, r * (cell.mine ? 0.05 : 0.03));
    if (cell.mine) {
      ctx.shadowColor = theme.borderGlow;
      ctx.shadowBlur = Math.max(6, r * 0.14);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (cell.kind !== 0 || r < 16) return;
    var name = cellName(cell);
    var mass = Math.max(1, Math.round(r * r / 100));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    if (name) {
      var fs = Math.max(14, r * 0.38);
      ctx.font = '700 ' + fs + 'px Ubuntu,Rajdhani,Segoe UI,sans-serif';
      ctx.strokeStyle = theme.nickStrokeColor;
      ctx.lineWidth = Math.max(3, fs * 0.16);
      ctx.strokeText(name, x, y - (mass ? r * 0.16 : 0));
      ctx.fillStyle = cell.mine ? theme.nickColor : '#f2f4f8';
      ctx.fillText(name, x, y - (mass ? r * 0.16 : 0));
    }
    ctx.font = '700 ' + Math.max(11, r * 0.26) + 'px Ubuntu,Rajdhani,Segoe UI,sans-serif';
    ctx.strokeStyle = theme.massStrokeColor;
    ctx.lineWidth = 4;
    ctx.strokeText(String(mass), x, y + (name ? r * 0.28 : 0));
    ctx.fillStyle = cell.mine ? theme.massColor : '#e8d5a3';
    ctx.fillText(String(mass), x, y + (name ? r * 0.28 : 0));
  }

  function draw() {
    rafId = 0;
    if (!playing) return;
    var canvas = document.getElementById('canvas') || document.getElementById('gameCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width !== innerWidth || canvas.height !== innerHeight) {
      canvas.width = innerWidth;
      canvas.height = innerHeight;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    fpsFrames++;
    var now = Date.now();
    // deo.onyx may create/rebuild #teamlist-alive after SPAWN_CONFIRMED.
    // Keep the guest Active counter synchronized with the actual FFA state.
    setAliveHud();
    if (!fpsLast) fpsLast = now;
    if (now - fpsLast >= 500) {
      fpsValue = Math.round(fpsFrames * 1000 / (now - fpsLast));
      fpsFrames = 0;
      fpsLast = now;
      var stats = document.getElementById('stats-hud') || document.getElementById('fps-hud');
      var massSum = ownMass();
      var hud = 'FPS: ' + fpsValue + '   Ping: ' + pingMs + ' ms' + (spawned ? '   Mass: ' + massSum : '');
      if (stats) stats.textContent = hud;
      if (global.ONYXUi && global.ONYXUi.updateStats) global.ONYXUi.updateStats(hud);
    }
    if (now - lastLeaderboardAt >= 500) {
      lastLeaderboardAt = now;
      updateFfaLeaderboard();
    }
    var ids = Object.keys(cells);
    var i;
    for (i = 0; i < ids.length; i++) {
      var c = cells[ids[i]];
      if (!c) continue;
      if (c.tx == null) { c.tx = c.x; c.ty = c.y; c.tr = c.r; }
      c.x = lerp(c.x, c.tx, 0.22);
      c.y = lerp(c.y, c.ty, 0.22);
      c.r = lerp(c.r, c.tr, 0.22);
    }
    var cx = 0;
    var cy = 0;
    var n = 0;
    var ownR = 0;
    for (i = 0; i < ownCells.length; i++) {
      var oc = cells[ownCells[i]];
      if (!oc) continue;
      cx += oc.x;
      cy += oc.y;
      ownR += oc.r;
      n++;
    }
    if (n) { cx /= n; cy /= n; ownR /= n; }
    else if (spectateX || spectateY) { cx = spectateX; cy = spectateY; }
    else if (border) { cx = border / 2; cy = border / 2; }
    if (!camX && !camY) { camX = cx; camY = cy; }
    camX = lerp(camX, cx, 0.14);
    camY = lerp(camY, cy, 0.14);
    var targetZoom = spawned
      ? Math.min(0.55, Math.max(0.09, (48 / Math.max(ownR, 36)) * (canvas.height / 1080)))
      : 0.12 * (canvas.height / 1080);
    camZoom = lerp(camZoom || targetZoom, targetZoom, 0.08);
    var theme = readOnyxTheme();
    ctx.fillStyle = theme.backgroundColor || '#0e0e12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camZoom, camZoom);
    ctx.translate(-camX, -camY);
    if (border) {
      ctx.strokeStyle = theme.borderColor;
      ctx.lineWidth = 18;
      ctx.strokeRect(0, 0, border, border);
    }
    var grid = 50;
    var viewW = canvas.width / camZoom;
    var viewH = canvas.height / camZoom;
    var x0 = Math.floor((camX - viewW / 2) / grid) * grid;
    var y0 = Math.floor((camY - viewH / 2) / grid) * grid;
    ctx.strokeStyle = theme.gridColor || '#1a1a20';
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1 / camZoom;
    ctx.beginPath();
    for (var gx = x0; gx < camX + viewW / 2; gx += grid) {
      ctx.moveTo(gx, camY - viewH / 2);
      ctx.lineTo(gx, camY + viewH / 2);
    }
    for (var gy = y0; gy < camY + viewH / 2; gy += grid) {
      ctx.moveTo(camX - viewW / 2, gy);
      ctx.lineTo(camX + viewW / 2, gy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    var list = [];
    for (i = 0; i < ids.length; i++) {
      if (cells[ids[i]]) list.push(cells[ids[i]]);
    }
    list.sort(function (a, b) { return a.r - b.r; });
    for (i = 0; i < list.length; i++) drawOnyxCell(ctx, list[i], theme);
    if (spawned && n) {
      ctx.strokeStyle = theme.cursorLineColor;
      ctx.globalAlpha = 0.12;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (i = 0; i < ownCells.length; i++) {
        var line = cells[ownCells[i]];
        if (!line) continue;
        ctx.moveTo(line.x, line.y);
        ctx.lineTo(mouseX, mouseY);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    drawMinimap(theme);
    rafId = requestAnimationFrame(draw);
  }

  function ownMass() {
    var sum = 0;
    var seen = Object.create(null);
    var i;
    for (i = 0; i < ownCells.length; i++) {
      var c = cells[ownCells[i]];
      if (!c || c.kind !== 0) continue;
      sum += Math.max(1, Math.round(c.r * c.r / 100));
      seen[c.id] = 1;
    }
    var ids = Object.keys(cells);
    for (i = 0; i < ids.length; i++) {
      var cell = cells[ids[i]];
      if (!cell || !cell.mine || cell.kind !== 0 || seen[cell.id]) continue;
      sum += Math.max(1, Math.round(cell.r * cell.r / 100));
      if (ownCells.indexOf(cell.id) === -1) ownCells.push(cell.id);
    }
    return sum;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function setTimeHud(seconds) {
    var el = document.getElementById('time-hud');
    if (!el) return;
    var s = Math.max(0, seconds | 0);
    el.textContent = pad2((s / 3600) | 0) + ':' + pad2(((s % 3600) / 60) | 0) + ':' + pad2(s % 60);
  }

  function setAliveHud() {
    var el = document.querySelector('#teamlist-alive span');
    if (el) el.textContent = spawned ? '1' : '0';
  }

  function drawMinimap(theme) {
    var canvas = document.getElementById('minimap-nodes');
    if (!canvas || !border) return;
    var size = canvas.width || 175;
    if (canvas.height !== size) canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    var scale = size / border;
    var ids = Object.keys(cells);
    for (var i = 0; i < ids.length; i++) {
      var cell = cells[ids[i]];
      if (!cell || cell.kind !== 0 || cell.r < 20) continue;
      var x = cell.x * scale;
      var y = cell.y * scale;
      var r = Math.max(2, cell.r * scale * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = cell.mine ? (theme.selfColor || '#e0a82e') : hexColor(cell.color || 0xffffff);
      ctx.globalAlpha = cell.mine ? 1 : 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (camX || camY) {
      var vw = (innerWidth / (camZoom || 0.2)) * scale;
      var vh = (innerHeight / (camZoom || 0.2)) * scale;
      ctx.strokeStyle = theme.borderColor || '#e0a82e';
      ctx.lineWidth = 1;
      ctx.strokeRect(camX * scale - vw / 2, camY * scale - vh / 2, vw, vh);
    }
  }

  function canvasToWorld(ev) {
    var canvas = document.getElementById('canvas') || document.getElementById('gameCanvas');
    if (!canvas) return;
    var scale = camZoom || (spawned ? 0.24 : 0.13);
    mouseX = (ev.clientX - canvas.width / 2) / scale + camX;
    mouseY = (ev.clientY - canvas.height / 2) / scale + camY;
  }

  function handleCodecClose(ev) {
    var code = ev && ev.code;
    if (global.__ONYX_FFA_CONNECTED__ && (code === 1000 || code === 1001)) {
      log('WebSocket closed after gameplay code=' + code);
      return;
    }
    var errCode = 'WS_ERROR';
    if (code === 1008 || code === 4001 || code === 4003) errCode = 'SERVER_REJECTED';
    if (!global.__ONYX_FFA_CONNECTED__ && (code === 1000 || code === 1005)) errCode = 'HANDSHAKE_FAILED';
    fail(errCode, 'close code=' + code + ' reason="' + ((ev && ev.reason) || '') + '" clean=' + !!(ev && ev.wasClean), {
      phase: lastPhase,
      authCompleted: authCompleted,
      clientReady: clientReady
    });
    stop('close');
  }

  function killWorker() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
    if (spawnTimer) { clearInterval(spawnTimer); clearTimeout(spawnTimer); spawnTimer = null; }
    if (spawnWaitTimer) { clearTimeout(spawnWaitTimer); spawnWaitTimer = null; }
    if (spawnReadyTimer) { clearTimeout(spawnReadyTimer); clearInterval(spawnReadyTimer); spawnReadyTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    socketOpen = false;
    workerReady = false;
    if (global.ONYXFfaCodec && global.ONYXFfaCodec.close) {
      try { global.ONYXFfaCodec.close(); } catch (_) {}
    }
    if (worker) {
      try { worker.postMessage({ type: 'close' }); } catch (_) {}
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
  }

  function resetSession() {
    authCompleted = false;
    guestHandshakeSent = false;
    clientReady = false;
    worldSeen = false;
    spawned = false;
    clientId = 0;
    playerIds = [];
    ownCells = [];
    cells = Object.create(null);
    players = Object.create(null);
    playerClients = Object.create(null);
    spawnSent = false;
    spawnAttempts = 0;
    spawnPidLogs = 0;
    inboundLogs = 0;
    syncRequested = false;
    identityReady = false;
    spectateEnabled = !!wantSpectate;
    spectateX = 0;
    spectateY = 0;
    seenKind0 = [];
    border = 0;
    turnstilePending = false;
    global.__ONYX_FFA_CONNECTED__ = false;
    var cap = document.getElementById('onyx-ffa-captcha');
    if (cap && cap.parentNode) cap.parentNode.removeChild(cap);
  }

  function startPageCodec() {
    var codec = global.ONYXFfaCodec;
    if (!codec) throw new Error('ONYXFfaCodec missing');
    workerReady = true;
    logCodec('READY');
    log('CODEC_READY');
    setPhase('CONNECTING');
    logWs('CONNECTING ' + FFA_HOST);
    log('CONNECTING');
    log('Connecting to ' + FFA_HOST);
    var url = buildFfaUrl();
    log('WS URL ' + url.replace(/([?&]tid=)[a-f0-9]+/i, '$1***'));
    return codec.connect(url, {
      onOpen: function () {
        socketOpen = true;
        setPhase('CONNECTED');
        logWs('OPEN');
        log('WS_OPEN');
        // Delta guest accepts the handshake immediately after the socket opens.
        // Waiting for legacy opcode 8 can leave the client stuck at CONNECTED.
        sendAuth();
      },
      onClose: handleCodecClose,
      onMessage: onServerPacket,
      onError: function (msg) { fail('WS_ERROR', msg); }
    });
  }

  function startWorker() {
    killWorker();
    resetSession();
    snapshotGlobals('before-page-codec');
    if (!global.ONYXFfaCodec) {
      fail('CODEC_FAILED', 'onyx-ffa-codec.js is not loaded');
      return;
    }
    startPageCodec().catch(function (err) {
      fail('CODEC_FAILED', err && err.message ? err.message : String(err));
    });
  }

  function onMouseMove(ev) {
    if (!playing) return;
    canvasToWorld(ev);
    sendCursor();
  }

  function onKeyDown(ev) {
    if (!playing) return;
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      sendSplit();
    } else if (ev.key === 'w' || ev.key === 'W') {
      sendFeed();
    }
  }

  async function play(profileOverride) {
    if (!isFfaSelected() && !(profileOverride && isFfaValue(profileOverride.server))) {
      return false;
    }

    if (playing && authCompleted && socketOpen) {
      wantSpectate = !!(profileOverride && profileOverride.spectate);
      playRequested = !wantSpectate;
      spawned = false;
      spawnSent = false;
      spawnAttempts = 0;
      seenKind0 = [];
      spectateEnabled = wantSpectate;
      if (wantSpectate) {
        logGame('SPECTATE');
        setPhase('IN_GAME');
        showFfaCanvas(true, true);
        sendCursor();
        return true;
      }
      showFfaCanvas(true, true);
      maybeSpawn();
      return true;
    }

    wantSpectate = !!(profileOverride && profileOverride.spectate);
    playRequested = !wantSpectate;
    snapshotGlobals('play');
    setPhase('GUEST');
    logAuth('SKIPPED');
    log('Delta FFAEU2 guest mode — no login required');

    showFfaCanvas(true, true);
    playing = true;
    startWorker();
    if (!rafId) rafId = requestAnimationFrame(draw);
    return true;
  }

  function stop(reason) {
    playing = false;
    lastPhase = 'IDLE';
    global.__ONYX_FFA_PLAYING__ = false;
    killWorker();
    resetSession();
    wantSpectate = false;
    playRequested = false;
    spectateEnabled = false;
    showFfaCanvas(false);
    if (reason === 'user') toast('FFA disconnected');
  }

  function playFromUi() {
    play(readUiProfile()).catch(function (err) {
      fail('INITIALIZATION_FAILED', err && err.message ? err.message : String(err));
    });
  }

  function restoreProfileFields() {
    try {
      var savedNick = localStorage.getItem('kateronyx:nick');
      var savedTag = localStorage.getItem('kateronyx:tag');
      var nickEl = document.getElementById('nick');
      var tagEl = document.getElementById('tag');
      if (nickEl && savedNick) nickEl.value = savedNick;
      if (tagEl && savedTag) tagEl.value = savedTag;
      if (savedNick) lastNick = savedNick;
      if (savedTag) lastTag = savedTag;
    } catch (_) {}
  }

  function interceptUi() {
    restoreProfileFields();
    ensureDeltaSelected();
    var selectAttempts = 0;
    var selectTimer = setInterval(function () {
      selectAttempts++;
      if (ensureDeltaSelected() || selectAttempts > 20) clearInterval(selectTimer);
    }, 150);
    document.addEventListener('click', function (e) {
      var playBtn = e.target && e.target.closest && e.target.closest('#button-play');
      if (!playBtn || global.__ONYX_DEO_INPUT_FALLBACK__ || !isFfaSelected()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      playFromUi();
    }, true);

    document.addEventListener('click', function (e) {
      var spec = e.target && e.target.closest && e.target.closest('#button-spectate');
      if (!spec || global.__ONYX_DEO_INPUT_FALLBACK__ || !isFfaSelected()) return;
      if (playRequested && spawnSent && !spawned) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      play(Object.assign(readUiProfile(), { spectate: true })).catch(function (err) {
        fail('INITIALIZATION_FAILED', err && err.message ? err.message : String(err));
      });
    }, true);

    document.addEventListener('click', function (e) {
      var loginBtn = e.target && e.target.closest && e.target.closest('#button-login');
      if (!loginBtn) return;
      e.preventDefault();
      if (global.ONYXAuth && global.ONYXAuth.openSenpaPanel) global.ONYXAuth.openSenpaPanel();
    }, true);

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== AUTH_ORIGIN) return;
    var data = event.data || {};
    var token = data.access_token || data.token;
    if (token) saveToken(token);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', interceptUi);
  } else {
    interceptUi();
  }

  if (isUserscriptRuntime()) {
    log('OG_RUNTIME = false');
    log('JAXX_RUNTIME = false');
    log('IFRAME = ' + (window !== window.top));
    log('USERSCRIPT = ' + !!global.__KATERONYX_USERSCRIPT__);
    log('PAGE_ORIGIN = ' + location.origin);
  }
  setPhase('BOOT');
  snapshotGlobals('boot');

  global.ONYXFfa = {
    VALUE: FFA_VALUE,
    WS_URL: FFA_WS,
    isFfaValue: isFfaValue,
    isFfaSelected: isFfaSelected,
    play: play,
    stop: stop,
    playFromUi: playFromUi,
    getPhase: function () { return lastPhase; },
    isPlaying: function () { return playing; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
