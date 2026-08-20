/**
 * New-server adapter for ONYX (deo.onyx + PIXI + WASM create).
 * Does not render, spawn, or open its own WebSocket.
 * Load BEFORE deo.onyx so auto-connect uses wsUrl (?po=&tid=) instead of ?password=.
 *
 * Confirmed deo URL: wss://<host>?password=
 * Confirmed Delta FFAEU2 URL: wss://eu.senpa.io:2001
 * Confirmed auth: opcode 13. FFA uses UInt16 length + UTF-16; deo writeString16 uses UInt8 length.
 */
(function (global) {
  'use strict';

  var NEW_FFA_HOST = 'eu.senpa.io:2001';
  var NEW_FFA_IDS = { 'ffa-eu': 1, 'delta-ffaeu2': 1, 'eu.senpa.io:2001': 1 };
  // Use deo.onyx's live SC input path for Delta Play/Spectate.
  var USE_DEO_INPUT_FALLBACK = true;
  var TID_KEY = 'kateronyx:delta-tid';
  var SECONDARY_SESSION_KEY = 'senpaio:session:secondary';
  var AUTH_ORIGIN = 'https://api.senpa.io';
  var secondaryStarted = false;
  var secondaryPending = false;
  var secondaryAuthPending = false;
  var secondaryAuthOverlay = null;
  var LEGACY_SUFFIX = '?password=';

  var cellInLog = 0;
  var cellOutLog = 0;
  var hooked = false;
  var spectateSent = false;
  var lastConnectHost = '';
  var origInit = null;
  var origSend = null;
  var origOnMessage = null;
  var origOnClose = null;
  var origOnError = null;
  var jwtNullWarned = false;
  var wasmWaitTimer = null;
  // Delta FFA sends leaderboard rows by client id; keep a small side map so
  // the legacy deo leaderboard decoder never has to touch the new packet shape.
  var deltaClients = Object.create(null);
  var deltaLeaderboard = [];
  var deltaLeaderboardHash = '';

  function log(tag, msg) {
    console.log('[NEW-SERVER] [' + tag + '] ' + msg);
  }

  function hex32() {
    var existing = '';
    try { existing = sessionStorage.getItem(TID_KEY) || ''; } catch (_) {}
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
    var hex;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      hex = crypto.randomUUID().replace(/-/g, '');
    } else if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      hex = Array.prototype.map.call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } else {
      hex = '00000000000000000000000000000000';
    }
    try { sessionStorage.setItem(TID_KEY, hex); } catch (_) {}
    return hex;
  }

  function selectedRaw() {
    var el = document.getElementById('servers');
    if (!el) return '';
    return String(el.value || '');
  }

  function selectedOption() {
    var el = document.getElementById('servers');
    if (!el || el.selectedIndex < 0) return null;
    return el.options[el.selectedIndex];
  }

  function ensureFfaSelection() {
    var el = document.getElementById('servers');
    if (!el || !el.options || !el.options.length) return false;
    var current = selectedOption();
    if (current && (current.getAttribute('data-onyx-type') === 'ffa' || current.getAttribute('data-onyx-host') === NEW_FFA_HOST || NEW_FFA_IDS[current.value])) return true;
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var marker = [opt.value || '', opt.textContent || '', opt.getAttribute('data-onyx-id') || '', opt.getAttribute('data-onyx-host') || '', opt.getAttribute('data-onyx-type') || ''].join(' ').toLowerCase();
      if (marker.indexOf('delta-ffaeu2') !== -1 || marker.indexOf('delta ffaeu2') !== -1 || marker.indexOf(NEW_FFA_HOST) !== -1) {
        if (opt.getAttribute('data-onyx-host')) opt.value = opt.getAttribute('data-onyx-host');
        el.selectedIndex = i;
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        log('CONNECT', 'PLAY auto-selected Delta FFAEU2 host=' + el.value);
        return true;
      }
    }
    return false;
  }

  function mapHost(raw) {
    var host = String(raw || '').trim();
    if (!host) {
      var opt = selectedOption();
      if (opt && opt.getAttribute('data-onyx-host')) host = opt.getAttribute('data-onyx-host');
      else host = selectedRaw();
    }
    if (host === 'ffa-eu' || host === 'delta-ffaeu2' || host.indexOf('ffa:') === 0) return NEW_FFA_HOST;
    var opt = selectedOption();
    if (opt && (opt.getAttribute('data-onyx-id') === 'ffa-eu' || opt.getAttribute('data-onyx-id') === 'delta-ffaeu2' || opt.value === 'ffa-eu' || opt.value === 'delta-ffaeu2')) {
      if (!host || host === 'ffa-eu' || host === 'delta-ffaeu2') return NEW_FFA_HOST;
    }
    if (opt && opt.getAttribute('data-onyx-host') && (host === 'ffa-eu' || host === 'delta-ffaeu2' || host === opt.value && (opt.getAttribute('data-onyx-id') === 'ffa-eu' || opt.getAttribute('data-onyx-id') === 'delta-ffaeu2'))) {
      return opt.getAttribute('data-onyx-host');
    }
    return host;
  }

  function isNewFfaHost(host) {
    host = mapHost(host);
    return host === NEW_FFA_HOST || host.indexOf(NEW_FFA_HOST) === 0;
  }

  function isNewFfaSelected() {
    var opt = selectedOption();
    if (opt) {
      if (opt.getAttribute('data-onyx-id') === 'ffa-eu' || opt.getAttribute('data-onyx-id') === 'delta-ffaeu2') return true;
      if (opt.getAttribute('data-onyx-type') === 'ffa') return true;
      if (NEW_FFA_IDS[opt.value]) return true;
      if (opt.getAttribute('data-onyx-host') === NEW_FFA_HOST) return true;
    }
    return isNewFfaHost(selectedRaw());
  }

  function wsUrl(host) {
    host = mapHost(host);
    if (isNewFfaHost(host)) return 'wss://' + NEW_FFA_HOST;
    return 'wss://' + NEW_FFA_HOST;
  }

  function readJwt(tab) {
    if ((tab || 1) === 2) {
      try {
        var secondary = localStorage.getItem(SECONDARY_SESSION_KEY) || '';
        if (secondary && secondary.split('.').length >= 3) return secondary;
      } catch (_) {}
      return 'null';
    }
    if (global.ONYXAuth && typeof global.ONYXAuth.getSenpaToken === 'function') {
      var t = global.ONYXAuth.getSenpaToken();
      if (t) return String(t);
    }
    try {
      var a = localStorage.getItem('senpaio:session') || '';
      if (a && a.split('.').length >= 3) return a;
      var b = localStorage.getItem('senpa_auth_token') || '';
      if (b && b.split('.').length >= 3) return b;
    } catch (_) {}
    return 'null';
  }

  function toU8(buf) {
    if (!buf) return null;
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (buf.buffer instanceof ArrayBuffer) {
      return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.buffer.byteLength);
    }
    return null;
  }

  function u16(u8, p) {
    return u8[p] | (u8[p + 1] << 8);
  }

  function readUtf16(u8, state, length) {
    if (length < 0 || state.p + length * 2 > u8.length) throw new RangeError('utf16 out of bounds');
    var out = '';
    for (var i = 0; i < length; i++) {
      out += String.fromCharCode(u8[state.p] | (u8[state.p + 1] << 8));
      state.p += 2;
    }
    return out;
  }

  function runtimeClientName(id) {
    var roots = [global.gs, global.__ONYX_GS__, global.zt, global];
    var keys = ['clientsList', 'playerClients', 'clients', 'playersList', 'players'];
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      if (!root) continue;
      for (var k = 0; k < keys.length; k++) {
        var collection = root[keys[k]];
        if (!collection) continue;
        var item = null;
        try {
          item = typeof collection.get === 'function' ? collection.get(id) : collection[id];
        } catch (_) { item = null; }
        if (!item) continue;
        var name = item.nick || item.name || item.nickname || item.playerName || '';
        if (name) return String(name);
      }
    }
    return '';
  }

  function renderDeltaLeaderboard() {
    var root = document.getElementById('leaderboard-positions');
    if (!root) return;
    var rows = root.querySelectorAll('.lb-position');
    if (!rows || !rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i].querySelector('[lbdata="name"]');
      if (!el) continue;
      var row = deltaLeaderboard[i];
      if (!row) { el.textContent = ''; continue; }
      var pc = deltaClients[row.clientId];
      var name = pc && (pc.nick || pc.name) || runtimeClientName(row.clientId);
      // Keep an id visible when the server has not sent its client map yet;
      // this prevents stale/blank rows and is replaced automatically later.
      el.textContent = name || ('#' + row.clientId);
    }
  }

  function parseDeltaClientPacket(u8) {
    if (!u8 || u8.length < 4 || u8[0] !== 10) return false;
    var state = { p: 1 };
    var staged = [];
    var updates = [];
    var deleted = [];
    try {
      var add = u8[state.p++];
      for (var i = 0; i < add; i++) {
        if (state.p + 3 > u8.length) throw new RangeError('client add header');
        var id = u16(u8, state.p); state.p += 2;
        var isBot = !!u8[state.p++];
        var nick = readUtf16(u8, state, u8[state.p++]);
        var tag = readUtf16(u8, state, u8[state.p++]);
        if (state.p + 4 > u8.length) throw new RangeError('client color');
        staged.push({ id: id, isBot: isBot, nick: nick, name: nick, tag: tag,
          color: (u8[state.p] << 16) | (u8[state.p + 1] << 8) | u8[state.p + 2],
          reserved: !!u8[state.p + 3] });
        state.p += 4;
      }
      if (state.p >= u8.length) throw new RangeError('client update count');
      var upd = u8[state.p++];
      for (i = 0; i < upd; i++) {
        if (state.p + 3 > u8.length) throw new RangeError('client update header');
        var uid = u16(u8, state.p); state.p += 2;
        var flags = u8[state.p++];
        var item = { id: uid, flags: flags };
        if (flags & 1) item.nick = readUtf16(u8, state, u8[state.p++]);
        if (flags & 2) item.tag = readUtf16(u8, state, u8[state.p++]);
        if (flags & 4) {
          if (state.p + 4 > u8.length) throw new RangeError('client update color');
          item.color = (u8[state.p] << 16) | (u8[state.p + 1] << 8) | u8[state.p + 2];
          item.reserved = !!u8[state.p + 3];
          state.p += 4;
        }
        updates.push(item);
      }
      if (state.p >= u8.length) throw new RangeError('client delete count');
      var del = u8[state.p++];
      if (state.p + del * 2 > u8.length) throw new RangeError('client deletes');
      for (i = 0; i < del; i++) { deleted.push(u16(u8, state.p)); state.p += 2; }
    } catch (err) {
      log('DECODE', 'Delta opcode=10 ignored safely: ' + (err && err.message || err));
      return false;
    }
    staged.forEach(function (item) { deltaClients[item.id] = item; });
    updates.forEach(function (item) {
      var row = deltaClients[item.id] || (deltaClients[item.id] = { id: item.id });
      if (item.nick !== undefined) { row.nick = item.nick; row.name = item.nick; }
      if (item.tag !== undefined) row.tag = item.tag;
      if (item.color !== undefined) { row.color = item.color; row.reserved = item.reserved; }
    });
    deleted.forEach(function (id) { delete deltaClients[id]; });
    renderDeltaLeaderboard();
    return true;
  }

  function parseDeltaLeaderboardPacket(u8) {
    if (!u8 || u8.length < 2 || u8[0] !== 21) return false;
    var count = u8[1] & 0x7f;
    var max = Math.min(count, Math.floor((u8.length - 2) / 6));
    var rows = [];
    for (var i = 0; i < max; i++) {
      var p = 2 + i * 6;
      rows.push({ clientId: u16(u8, p), score: (u8[p + 2] | (u8[p + 3] << 8) | (u8[p + 4] << 16) | (u8[p + 5] << 24)) >>> 0 });
    }
    rows.sort(function (a, b) { return b.score - a.score; });
    deltaLeaderboard = rows;
    var hash = rows.map(function (row) { return row.clientId + ':' + row.score; }).join('|');
    if (hash !== deltaLeaderboardHash) {
      deltaLeaderboardHash = hash;
      log('LEADERBOARD', 'rows=' + rows.length + ' names=' + rows.map(function (row) {
        var pc = deltaClients[row.clientId];
        return (pc && (pc.nick || pc.name)) || runtimeClientName(row.clientId) || ('#' + row.clientId);
      }).join(', '));
    }
    renderDeltaLeaderboard();
    return true;
  }

  function handleDeltaPacket(u8) {
    if (!u8 || !u8.length) return;
    if (u8[0] === 10) parseDeltaClientPacket(u8);
    else if (u8[0] === 21) parseDeltaLeaderboardPacket(u8);
  }

  function buildAuthPacket(token) {
    token = String(token || 'null');
    var buf = new ArrayBuffer(1 + 2 + token.length * 2);
    var v = new DataView(buf);
    v.setUint8(0, 0x0d);
    v.setUint16(1, token.length, true);
    for (var i = 0; i < token.length; i++) v.setUint16(3 + i * 2, token.charCodeAt(i), true);
    return buf;
  }

  function sendDeoSpectate(sc) {
    if (!sc || typeof sc.send !== 'function') return;
    var buf = new ArrayBuffer(10);
    var v = new DataView(buf);
    v.setUint8(0, 20);
    v.setUint8(1, 1);
    v.setInt32(2, 0, true);
    v.setInt32(6, 0, true);
    origSend ? origSend.call(sc, buf, 1) : sc.send(buf, 1);
    log('PACKET-OUT', 'opcode=20 spectate-ready length=10 x=0 y=0');
  }

  function opcodeName(op, dir) {
    var names = {
      0: dir === 'in' ? 'serverInfo' : 'spawn',
      5: 'timer',
      7: 'captcha',
      8: 'authFlag',
      10: dir === 'in' ? 'updatePlayerClients' : 'nick',
      11: dir === 'in' ? 'updatePlayers' : 'tag',
      13: 'auth',
      14: 'captchaToken',
      20: dir === 'in' ? 'worldUpdate' : 'mouse/spectate',
      21: 'leaderboard',
      22: 'split',
      23: dir === 'in' ? 'spectateCamera' : 'feed',
      30: 'ping',
      31: 'fullSync',
      40: 'chat',
      41: 'serverChat'
    };
    return names[op] || 'UNKNOWN';
  }

  function describePacket(u8, dir) {
    if (!u8 || !u8.length) return 'empty';
    var op = u8[0];
    var extra = opcodeName(op, dir);
    if (dir === 'in' && op === 0 && u8.length >= 7) {
      var border = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
      var clientId = u8[5] | (u8[6] << 8);
      extra += ' border=' + (border >>> 0) + ' clientId=' + clientId;
    }
    if (dir === 'out' && op === 13) extra += ' jwtChars=' + Math.max(0, (u8.length - 3) / 2);
    return 'opcode=' + op + ' (' + extra + ') length=' + u8.length + ' dir=' + dir;
  }

  function shouldLogPacket(u8, dir) {
    if (!u8 || !u8.length) return true;
    var op = u8[0];
    if (op === 20) {
      if (dir === 'in') {
        cellInLog++;
        return cellInLog <= 3;
      }
      cellOutLog++;
      return cellOutLog <= 3;
    }
    if (op === 30) return false;
    return true;
  }

  function seedExtrasServer() {
    var host = mapHost(selectedRaw()) || NEW_FFA_HOST;
    var prefixes = ['ONYXPROD540-', 'ONYXPROD532-'];
    var migrateKey = 'ONYXPROD540-ffaHostV19';
    var migrated = false;
    try { migrated = localStorage.getItem(migrateKey) === '1'; } catch (_) {}
    for (var i = 0; i < prefixes.length; i++) {
      var key = prefixes[i] + 'extras';
      var data = {};
      try { data = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { data = {}; }
      var stale = !data.server || data.server === 'ffa-eu' || String(data.server).indexOf('ffa:') === 0;
      if (!migrated || stale) {
        data.server = host;
        try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
        log('CONNECT', 'seeded extras.server=' + host);
      }
    }
    try { localStorage.setItem(migrateKey, '1'); } catch (_) {}
  }

  function seedChatType() {
    var prefixes = ['ONYXPROD540-', 'ONYXPROD532-'];
    var migrateKey = 'ONYXPROD540-chatroomV198';
    var migrated = false;
    try { migrated = localStorage.getItem(migrateKey) === '1'; } catch (_) {}
    for (var i = 0; i < prefixes.length; i++) {
      var key = prefixes[i] + 'settings';
      var data = {};
      try { data = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { data = {}; }
      if (!migrated && (!data.chatType || data.chatType === 'normal' || data.chatType === 'popup')) {
        data.chatType = 'chatroom';
        try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
        log('ONYX-ENGINE', 'chatType → chatroom (Senpa persistent list)');
      }
    }
    try { localStorage.setItem(migrateKey, '1'); } catch (_) {}
  }

  function asSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  function syncFfaType() {
    if (!isNewFfaSelected()) return;
    // deo's renderer branches on this flag. Create the public holder if the
    // legacy bundle has not exposed it yet, then re-apply it on every packet.
    if (!global.zt || typeof global.zt !== 'object') global.zt = {};
    global.zt.ffaServerType = true;
    global.__ONYX_FFA_MODE__ = true;
    var keys = ['cellsIDTab1', 'cellsIDTab2'];
    var roots = [global.__ONYX_GS__, global.gs, global];
    for (var r = 0; r < roots.length; r++) {
      var obj = roots[r];
      if (!obj || typeof obj !== 'object') continue;
      for (var k = 0; k < keys.length; k++) {
        if (obj[keys[k]] != null && typeof obj[keys[k]].has !== 'function') {
          obj[keys[k]] = asSet(obj[keys[k]]);
          log('GAME-STATE', 'converted ' + keys[k] + ' Array → Set');
        }
      }
    }
  }

  function multiboxOn() {
    try {
      var prefixes = ['ONYXPROD540-', 'ONYXPROD532-'];
      for (var i = 0; i < prefixes.length; i++) {
        var s = JSON.parse(localStorage.getItem(prefixes[i] + 'settings') || '{}') || {};
        if (s.multiboxMode && s.multiboxMode !== 'off') return true;
      }
    } catch (_) {}
    return false;
  }

  function isJwtLike(token) {
    return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(String(token || ''));
  }

  function secondaryTokenPresent() {
    try { return isJwtLike(localStorage.getItem(SECONDARY_SESSION_KEY) || ''); } catch (_) { return false; }
  }

  function closeSecondaryAuthOverlay() {
    secondaryAuthPending = false;
    global.__ONYX_SECONDARY_AUTH_PENDING__ = false;
    if (secondaryAuthOverlay && secondaryAuthOverlay.parentNode) secondaryAuthOverlay.parentNode.removeChild(secondaryAuthOverlay);
    secondaryAuthOverlay = null;
  }

  function startSecondary(sc) {
    if (secondaryStarted || secondaryPending) return;
    if (!sc || !sc.Tab1) {
      log('CONNECT', 'Tab pressed before Tab 1 is ready; keeping Secondary closed');
      return;
    }
    log('AUTH', 'Delta guest mode — secondary login skipped');
    secondaryPending = true;
    try {
      sc.init(lastConnectHost || NEW_FFA_HOST, 2);
    } catch (err) {
      secondaryPending = false;
      log('CONNECT', 'tab=2 start failed — ' + (err && err.message || err));
    }
  }

  function requestSecondaryAuth(sc) {
    if (secondaryAuthPending) return;
    secondaryAuthPending = true;
    global.__ONYX_SECONDARY_AUTH_PENDING__ = true;
    var overlay = document.createElement('div');
    overlay.id = 'onyx-secondary-auth-overlay';
    overlay.innerHTML = '<div class="onyx-secondary-auth-card" role="dialog" aria-modal="true">' +
      '<h2>Login for Secondary Bot</h2>' +
      '<p id="onyx-secondary-auth-status">Choose a separate Facebook or Discord account for Tab 2.</p>' +
      '<div class="onyx-secondary-auth-actions"><button type="button" data-provider="discord">Login with Discord</button><button type="button" data-provider="facebook">Login with Facebook</button></div>' +
      '<button type="button" data-cancel class="onyx-secondary-auth-cancel">Cancel</button></div>';
    var style = document.createElement('style');
    style.textContent = '#onyx-secondary-auth-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.76);font:16px system-ui,sans-serif;color:#eef4ff}#onyx-secondary-auth-overlay .onyx-secondary-auth-card{width:min(92vw,440px);padding:24px;border:1px solid #d39d2e;border-radius:14px;background:#111318;box-shadow:0 18px 70px #000;text-align:center}#onyx-secondary-auth-overlay h2{margin:0 0 10px}#onyx-secondary-auth-overlay p{color:#c8d5e6;line-height:1.45}#onyx-secondary-auth-overlay button{border:0;border-radius:8px;padding:11px 15px;margin:4px;cursor:pointer;color:#fff;background:#5865f2;font-weight:700}#onyx-secondary-auth-overlay button[data-provider="facebook"]{background:#1877f2}#onyx-secondary-auth-overlay .onyx-secondary-auth-cancel{background:#3a4655;font-weight:500}';
    overlay.appendChild(style);
    document.body.appendChild(overlay);
    secondaryAuthOverlay = overlay;
    function openProvider(provider) {
      var popup = window.open(AUTH_ORIGIN + (provider === 'facebook' ? '/auth/facebook' : '/auth/discord'), 'Onyx Secondary Login', 'toolbar=no,menubar=no,width=600,height=700,top=100,left=100');
      var status = overlay.querySelector('#onyx-secondary-auth-status');
      if (!popup) { if (status) status.textContent = 'Popup blocked. Allow popups, then try again.'; return; }
      if (status) status.textContent = 'Finish the second account login in the popup, then return here.';
      try { popup.focus(); } catch (_) {}
    }
    overlay.querySelectorAll('[data-provider]').forEach(function (button) {
      button.addEventListener('click', function () { openProvider(button.getAttribute('data-provider')); });
    });
    overlay.querySelector('[data-cancel]').addEventListener('click', function () { closeSecondaryAuthOverlay(); });
  }

  function onSecondaryAuthMessage(event) {
    if (!secondaryAuthPending || event.origin !== AUTH_ORIGIN) return;
    var data = event.data || {};
    if (data.type === 'senpa-auth-ready') {
      try { event.source && event.source.postMessage({ type: 'senpa-auth-hello' }, AUTH_ORIGIN); } catch (_) {}
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    var token = data.access_token || data.token;
    if (!token || !isJwtLike(token)) return;
    try { localStorage.setItem(SECONDARY_SESSION_KEY, String(token)); } catch (_) { return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSecondaryAuthOverlay();
    startSecondary(global.SC);
  }

  function bindSecondaryTab(sc) {
    if (document.__onyxSecondaryTabBound) return;
    document.__onyxSecondaryTabBound = true;
    window.addEventListener('message', onSecondaryAuthMessage, true);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
      if (secondaryStarted || secondaryPending) return;
      if (!sc || !sc.Tab1 || sc.Tab2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      startSecondary(sc);
    }, true);
    log('CONNECT', 'Secondary gate bound to first Tab');
  }

  function hookSC() {
    var sc = global.SC;
    if (!sc || hooked) return !!hooked;
    if (typeof sc.init !== 'function' || typeof sc.send !== 'function') return false;

    origInit = sc.init.bind(sc);
    origSend = sc.send.bind(sc);
    origOnMessage = typeof sc.onMessage === 'function' ? sc.onMessage.bind(sc) : null;
    origOnClose = typeof sc.onClose === 'function' ? sc.onClose.bind(sc) : null;
    origOnError = typeof sc.onError === 'function' ? sc.onError.bind(sc) : null;

    sc.init = function (host, tab) {
      var mapped = mapHost(host);
      lastConnectHost = mapped;
      if ((tab || 1) === 1 && isNewFfaHost(mapped)) {
        deltaClients = Object.create(null);
        deltaLeaderboard = [];
        deltaLeaderboardHash = '';
        renderDeltaLeaderboard();
      }
      spectateSent = false;
      cellInLog = 0;
      cellOutLog = 0;
      syncFfaType();
      tab = tab || 1;
      if (tab === 2 && !secondaryPending && !secondaryStarted && isNewFfaHost(mapped)) {
        log('CONNECT', 'tab=2 guest start allowed for Delta');
        secondaryPending = true;
      }
      if (isNewFfaHost(mapped)) {
        log('CONNECT', 'host=' + mapped + ' tab=' + tab + ' url=' + wsUrl(mapped).replace(/([?&]tid=)[a-f0-9]+/i, '$1***'));
        log('ONYX-ENGINE', 'SC.init → deo WASM create() (single runtime)');
      } else {
        log('CONNECT', 'legacy host=' + mapped + ' tab=' + tab + ' suffix=?password=');
      }
      try {
        var result = origInit(mapped, tab);
      } catch (err) {
        if (tab === 2) {
          secondaryPending = false;
          secondaryStarted = false;
          log('CONNECT', 'tab=2 create failed — ' + (err && err.message || err));
          return;
        }
        throw err;
      }
      if (tab === 1 && isNewFfaHost(mapped)) {
        if (wasmWaitTimer) { clearInterval(wasmWaitTimer); wasmWaitTimer = null; }
        log('CONNECT', 'tab=1 only — tab=2 waits for first Tab and Secondary login');
      }
      if ((tab || 1) === 2) {
        secondaryPending = false;
        secondaryStarted = true;
        log('CONNECT', 'tab=2 started by explicit Tab action');
      }
      return result;
    };

    sc.send = function (buf, tab) {
      var u8 = toU8(buf);
      if (u8 && u8.length && isNewFfaHost(lastConnectHost || selectedRaw())) {
        if (u8[0] === 0x0d) {
          var authText = '';
          try {
            var authLen = u8.length >= 3 ? (u8[1] | (u8[2] << 8)) : 0;
            for (var ai = 0; ai < authLen && 3 + ai * 2 + 1 < u8.length; ai++) {
              authText += String.fromCharCode(u8[3 + ai * 2] | (u8[4 + ai * 2] << 8));
            }
          } catch (_) {}
          if (authText === 'null') {
            log('AUTH', 'opcode=13 guest null handshake allowed');
          } else {
            log('AUTH', 'opcode=13 JWT packet suppressed — guest mode');
            return;
          }
        }
        if (shouldLogPacket(u8, 'out')) log('PACKET-OUT', describePacket(u8, 'out') + ' tab=' + (tab || 1));
      }
      return origSend(buf, tab);
    };

    if (origOnMessage) {
      sc.onMessage = function (data, tab) {
        var u8 = toU8(data);
        var isDelta = u8 && u8.length && isNewFfaHost(lastConnectHost || selectedRaw());
        // deo uses the old opcode-10 string layout and throws on Delta packets.
        // The isolated FFA parser owns player names, so do not feed Delta opcode 10 to deo.
        var skipDeoPacket = isDelta && (u8[0] === 10 || u8[0] === 21);
        if (skipDeoPacket) log('DECODE', 'skip deo opcode=' + u8[0] + '; adapter owns Delta packet');
        var result = null;
        if (!skipDeoPacket) {
          try {
            result = origOnMessage(data, tab);
          } catch (err) {
            // A legacy decoder must never abort the live socket on a new-server
            // packet. Keep the FFA input/render loop alive and continue parsing.
            log('DECODE', 'deo packet ignored safely opcode=' + u8[0] + ' error=' + (err && err.message || err));
          }
        }
        if (isDelta) {
          syncFfaType();
          handleDeltaPacket(u8);
          if (shouldLogPacket(u8, 'in')) log('PACKET-IN', describePacket(u8, 'in') + ' tab=' + (tab || 1));
          if (u8[0] === 0) {
            log('HANDSHAKE', describePacket(u8, 'in'));
            log('GAME-STATE', 'serverInfo received — isolated FFA input path active');
            // Do not inject deo's legacy spectate-ready opcode 20 here.
            // ONYXFfa sends the correct play/spectate cursor after the user's action.
          }
          if (u8[0] === 8) log('AUTH', 'server opcode=8 → deo auth()');
          if (u8[0] === 7) log('HANDSHAKE', 'server captcha opcode=7 — deo sends opcode 14');
        }
        return result;
      };
    }

    if (origOnClose) {
      sc.onClose = function (tab) {
        log('DISCONNECT', 'tab=' + (tab || 1));
        if ((tab || 1) === 2) { secondaryStarted = false; secondaryPending = false; }
        spectateSent = false;
        return origOnClose(tab);
      };
    }

    if (origOnError) {
      sc.onError = function (tab) {
        log('DISCONNECT', 'error tab=' + (tab || 1));
        return origOnError(tab);
      };
    }

    hooked = true;
    bindSecondaryTab(sc);
    log('ONYX-ENGINE', 'adapter wrapped SC.init/send/onMessage');
    syncFfaType();
    return true;
  }

  function bindMenu() {
    var servers = document.getElementById('servers');
    if (servers && !servers.__onyxAdapterBound) {
      servers.__onyxAdapterBound = true;
      servers.addEventListener('change', function () {
        var host = mapHost(servers.value);
        log('CONNECT', 'menu host=' + host + ' newFfa=' + isNewFfaHost(host));
        syncFfaType();
      });
    }
    if (!document.__onyxAdapterPlayBound) {
      document.__onyxAdapterPlayBound = true;
      document.addEventListener('click', function (e) {
        var play = e.target && e.target.closest && e.target.closest('#button-play');
        if (!play) return;
        ensureFfaSelection();
        syncFfaType();
        if (isNewFfaSelected() && USE_DEO_INPUT_FALLBACK) {
          log('INPUT', 'PLAY → deo.onyx Delta fallback; guest SC input enabled');
          return;
        }
        if (isNewFfaSelected()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          log('INPUT', 'PLAY → ONYXFfa Delta path; deo.onyx blocked');
          if (global.ONYXFfa && typeof global.ONYXFfa.playFromUi === 'function') {
            global.ONYXFfa.playFromUi();
          }
          return;
        }
        log('INPUT', 'PLAY → deo.onyx #button-play (legacy path)');
      }, true);
    }
  }

  function installWasmLocate() {
    global.k = global.k || {};
    global.k.locateFile = function (name, path) {
      name = String(name || '');
      if (global.__KATERONYX_WASM89_BLOB__ && /89\.wasm/i.test(name) && !/899\.wasm/i.test(name)) {
        return global.__KATERONYX_WASM89_BLOB__;
      }
      if (global.__KATERONYX_WASM_BLOB__) return global.__KATERONYX_WASM_BLOB__;
      if (/89\.wasm/i.test(name) && !/899\.wasm/i.test(name)) return (path || '') + '89.wasm';
      return (path || '') + (name || '899.wasm');
    };
    if (global.__KATERONYX_WASM_BLOB__) log('ONYX-ENGINE', 'locateFile → wasm blobs (game+89)');
  }

  function boot() {
    installWasmLocate();
    seedExtrasServer();
    seedChatType();
    bindMenu();
    if (!hookSC()) {
      var n = 0;
      var t = setInterval(function () {
        n++;
        bindMenu();
        if (hookSC() || n > 80) clearInterval(t);
      }, 100);
    }
    log('ONYX-ENGINE', global.ONYXFfa ? 'adapter ready — onyx-ffa.js loaded' : 'adapter ready — onyx-ffa.js unavailable');
    log('RENDER', global.ONYXFfa ? '#gameCanvas FFA path available' : '#canvas PIXI (deo) fallback');
    log('DECODE', 'deo suffix 0x386="?password=" 0x83d="wss://" — FFA adds ?po=&tid=');
  }

  global.__ONYX_ADAPTER__ = {
    wsUrl: wsUrl,
    mapHost: mapHost,
    isNewFfa: isNewFfaSelected,
    readJwt: readJwt
  };
  global.ONYXFfaAdapter = global.__ONYX_ADAPTER__;
  global.__ONYX_DEO_INPUT_FALLBACK__ = USE_DEO_INPUT_FALLBACK;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
