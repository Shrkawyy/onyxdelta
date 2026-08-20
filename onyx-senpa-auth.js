/**
 * Senpa auth for ONYX: Discord OAuth popup or pasted JWT.
 * Stores senpaio:session + senpa_auth_token. Does not seed a hardcoded token.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'senpa_auth_token';
  var PROFILE_KEY = 'senpa_last_profile';
  var SESSION_KEY = 'senpaio:session';
  var AUTH_ORIGIN = 'https://api.senpa.io';

  var HELPER = `(async () => {
  const readToken = () => {
    const fromStorage =
      localStorage.getItem("senpaio:session") ||
      localStorage.getItem("senpa_auth_token") ||
      localStorage.getItem("authToken") ||
      localStorage.getItem("token") ||
      sessionStorage.getItem("authToken");
    if (fromStorage) return fromStorage;

    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("authToken=") || part.startsWith("token="));
    if (cookie) return decodeURIComponent(cookie.split("=").slice(1).join("="));

    try {
      const raw = localStorage.getItem("senpaio:account");
      if (raw) {
        let text = raw;
        try {
          const bin = atob(raw);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          if (bytes.length >= 2 && bytes[1] === 0) {
            text = new TextDecoder("utf-16le").decode(bytes);
          }
        } catch (_) {}
        const data = JSON.parse(text);
        if (data && data.auth) return data.auth;
      }
    } catch (_) {}

    return null;
  };

  const token = readToken();
  if (!token) {
    console.warn("[ONYX] No Senpa auth token found. Make sure you are logged in on senpa.io.");
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    console.log("[ONYX] Senpa auth token copied to clipboard.");
  } catch {
    console.log("[ONYX] Token copied failed; token is present in storage.");
  }
  return token;
})();`;

  function normalizeToken(raw) {
    return String(raw || '').trim().replace(/^["']|["']$/g, '');
  }

  function decodeJwtPayload(token) {
    var parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function isJwtAlive(token) {
    var payload = decodeJwtPayload(token);
    if (!payload) return false;
    if (payload.exp && payload.exp * 1000 <= Date.now()) return false;
    return true;
  }

  function getToken() {
    try {
      var a = normalizeToken(localStorage.getItem(SESSION_KEY));
      if (a && isJwtAlive(a)) return a;
      var b = normalizeToken(localStorage.getItem(STORAGE_KEY));
      if (b && isJwtAlive(b)) return b;
    } catch (_) {}
    return '';
  }

  function setToken(token) {
    localStorage.setItem(STORAGE_KEY, token);
    try { localStorage.setItem(SESSION_KEY, token); } catch (_) {}
  }

  function clearToken() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROFILE_KEY);
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function setProfile(profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile || null));
  }

  function login(raw) {
    var token = normalizeToken(raw);
    if (!token || token.split('.').length < 3) {
      throw new Error('Paste a valid Senpa auth token (JWT)');
    }
    if (!isJwtAlive(token)) {
      throw new Error('Senpa session expired. Login again.');
    }
    setToken(token);
    var profile = decodeJwtPayload(token) || { name: 'Senpa Player' };
    setProfile(profile);
    window.dispatchEvent(new CustomEvent('onyx:senpa-auth-changed', {
      detail: { token: token, profile: profile, isAuthenticated: true }
    }));
    window.dispatchEvent(new CustomEvent('senpa-auth-updated'));
    return profile;
  }

  function logout() {
    clearToken();
    window.dispatchEvent(new CustomEvent('onyx:senpa-auth-changed', {
      detail: { token: null, profile: null, isAuthenticated: false }
    }));
  }

  function injectUI() {
    if (document.getElementById('onyx-game-auth')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#onyx-auth-fab{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 12px;border:0;border-radius:8px;background:#12151c;color:#e8ecf3;font:600 12px/1.2 Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}',
      '#onyx-auth-fab.ok{background:#163022;color:#b7f0c8}',
      '#onyx-auth-fab .dot{width:8px;height:8px;border-radius:50%;background:#f0b429}',
      '#onyx-auth-fab.ok .dot{background:#3ddc84}',
      '#onyx-game-auth{display:none;position:fixed;inset:0;z-index:2147483001;background:rgba(6,8,12,.72);align-items:center;justify-content:center;padding:20px}',
      '#onyx-game-auth.open{display:flex}',
      '#onyx-game-auth .card{width:min(520px,100%);background:#10141c;color:#e8ecf3;border:1px solid #2a3344;border-radius:12px;padding:18px 18px 16px;box-shadow:0 20px 50px rgba(0,0,0,.45);font:14px/1.45 Segoe UI,system-ui,sans-serif}',
      '#onyx-game-auth h2{margin:0 0 4px;font-size:16px;letter-spacing:.04em}',
      '#onyx-game-auth .sub{margin:0 0 14px;color:#9aa6b8;font-size:12px}',
      '#onyx-game-auth ol{margin:0 0 12px;padding-left:18px;color:#b7c0ce;font-size:12px}',
      '#onyx-game-auth textarea{width:100%;min-height:96px;resize:vertical;box-sizing:border-box;border:1px solid #2a3344;border-radius:8px;background:#0b0e14;color:#e8ecf3;padding:10px;font:12px/1.4 Consolas,monospace}',
      '#onyx-game-auth .row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '#onyx-game-auth button{border:0;border-radius:8px;padding:9px 12px;cursor:pointer;font:600 12px/1 Segoe UI,system-ui,sans-serif}',
      '#onyx-game-auth .login{background:#3b82f6;color:#fff}',
      '#onyx-game-auth .auth-discord-btn{background:#5865F2}',
      '#onyx-game-auth .auth-facebook-btn{background:#1877F2}',
      '#onyx-game-auth .copy{background:#1e2633;color:#d7dee9}',
      '#onyx-game-auth .logout{background:#3a1d1d;color:#ffb4b4}',
      '#onyx-game-auth .close{background:#1e2633;color:#d7dee9;margin-left:auto}',
      '#onyx-game-auth .status{min-height:18px;margin-top:10px;font-size:12px;color:#9aa6b8}',
      '#onyx-game-auth .status.ok{color:#3ddc84}',
      '#onyx-game-auth .status.err{color:#ff7b7b}',
      '#onyx-game-auth .helper{margin-top:12px;padding:10px;border-radius:8px;background:#0b0e14;border:1px solid #2a3344;color:#8b97a8;font:11px/1.4 Consolas,monospace;white-space:pre-wrap;max-height:120px;overflow:auto}'
    ].join('');
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'onyx-auth-fab';
    fab.type = 'button';
    fab.innerHTML = '<span class="dot"></span><span class="label">SENPA AUTH</span>';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'onyx-game-auth';
    panel.innerHTML =
      '<div class="card">' +
        '<h2>AUTH LINK / SENPA ACCOUNT</h2>' +
        '<p class="sub">Same as old ONYX / Agar24 — paste Senpa JWT. Saved in localStorage.</p>' +
        '<ol>' +
          '<li>Login on <b>https://senpa.io/web</b></li>' +
          '<li>F12 → Console → Copy helper → Enter (copies JWT)</li>' +
          '<li>Paste token → LOGIN</li>' +
        '</ol>' +
        '<textarea class="auth-token-input" placeholder="Paste Senpa auth token here" spellcheck="false"></textarea>' +
        '<div class="row">' +
          '<button type="button" class="login auth-discord-btn">Login with Discord</button>' +
          '<button type="button" class="login auth-facebook-btn">Login with Facebook</button>' +
          '<button type="button" class="login auth-login-btn">LOGIN (paste)</button>' +
          '<button type="button" class="copy auth-copy-helper">Copy helper</button>' +
          '<button type="button" class="logout auth-logout-btn">Logout</button>' +
          '<button type="button" class="close auth-close-btn">Close</button>' +
        '</div>' +
        '<div class="status"></div>' +
        '<div class="helper auth-helper-code"></div>' +
      '</div>';
    document.body.appendChild(panel);

    var input = panel.querySelector('.auth-token-input');
    var status = panel.querySelector('.status');
    var helperEl = panel.querySelector('.auth-helper-code');
    helperEl.textContent = HELPER;

    function setStatus(msg, kind) {
      status.textContent = msg || '';
      status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function refreshFab() {
      var token = getToken();
      var profile = getProfile();
      var name = (profile && (profile.username || profile.nickname || profile.name)) || '';
      fab.classList.toggle('ok', !!token);
      fab.querySelector('.label').textContent = token
        ? ('ONYX: ' + (name || 'JWT saved'))
        : 'ONYX JWT LOGIN';
      var menuStatus = document.getElementById('onyx-jwt-status');
      if (menuStatus) {
        menuStatus.textContent = token
          ? ('JWT saved' + (name ? (': ' + name) : ''))
          : 'Paste JWT then JWT LOGIN';
        menuStatus.style.color = token ? '#3ddc84' : '#9aa6b8';
      }
      var menuInput = document.getElementById('onyx-jwt-input');
      if (menuInput && token && !menuInput.value) menuInput.value = token;
      if (input && token && !input.value) input.value = token;
    }

    function open() {
      panel.classList.add('open');
      setStatus(getToken() ? 'JWT saved. Ready to play.' : 'Paste Senpa JWT to login.', '');
      input.focus();
    }

    function close() {
      panel.classList.remove('open');
    }

    function applyJwt(raw) {
      var profile = login(raw);
      var name = profile.username || profile.nickname || profile.name || 'ok';
      setStatus('Login successful: ' + name, 'ok');
      refreshFab();
      return profile;
    }

    var menuLogin = document.getElementById('onyx-jwt-login');
    var menuInput = document.getElementById('onyx-jwt-input');
    if (menuLogin && menuInput) {
      menuLogin.addEventListener('click', function () {
        try {
          applyJwt(menuInput.value);
        } catch (err) {
          var menuStatus = document.getElementById('onyx-jwt-status');
          if (menuStatus) {
            menuStatus.textContent = err.message || String(err);
            menuStatus.style.color = '#ff7b7b';
          }
          setStatus(err.message || String(err), 'err');
        }
      });
    }

    fab.addEventListener('click', open);
    panel.querySelector('.auth-close-btn').addEventListener('click', close);
    panel.addEventListener('click', function (e) {
      if (e.target === panel) close();
    });

    function openOAuth(provider, title, label) {
      var popup = window.open(
        AUTH_ORIGIN + '/auth/' + provider,
        title,
        'toolbar=no,menubar=no,width=600,height=700,top=100,left=100'
      );
      if (!popup) {
        setStatus('Popup blocked. Allow popups or paste a token.', 'err');
        return;
      }
      setStatus('Complete Senpa ' + label + ' login in the popup…', '');
      try { popup.focus(); } catch (_) {}
    }

    panel.querySelector('.auth-discord-btn').addEventListener('click', function () {
      openOAuth('discord', 'Senpa Discord Login', 'Discord');
    });

    panel.querySelector('.auth-facebook-btn').addEventListener('click', function () {
      openOAuth('facebook', 'Senpa Facebook Login', 'Facebook');
    });

    panel.querySelector('.auth-login-btn').addEventListener('click', function () {
      try {
        var profile = applyJwt(input.value);
        setTimeout(close, 500);
      } catch (err) {
        setStatus(err.message || String(err), 'err');
      }
    });

    panel.querySelector('.auth-logout-btn').addEventListener('click', function () {
      logout();
      input.value = '';
      var menuIn = document.getElementById('onyx-jwt-input');
      if (menuIn) menuIn.value = '';
      setStatus('Logged out.', '');
      refreshFab();
    });

    panel.querySelector('.auth-copy-helper').addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(HELPER);
        setStatus('Helper copied.', 'ok');
      } catch (_) {
        setStatus('Copy failed — select helper text manually.', 'err');
      }
    });

    window.addEventListener('onyx:senpa-auth-changed', refreshFab);

    window.addEventListener('message', function (event) {
      if (event.origin !== AUTH_ORIGIN) return;
      if (window.__ONYX_SECONDARY_AUTH_PENDING__) return;
      var data = event.data || {};
      if (data.type === 'senpa-auth-ready') {
        try { event.source && event.source.postMessage({ type: 'senpa-auth-hello' }, AUTH_ORIGIN); } catch (_) {}
        return;
      }
      var token = data.access_token || data.token;
      if (!token) return;
      try {
        login(token);
        setStatus('Login successful (Senpa OAuth).', 'ok');
        refreshFab();
        setTimeout(close, 400);
      } catch (err) {
        setStatus(err.message || String(err), 'err');
      }
    });

    try {
      var existing = getToken();
      if (existing && isJwtAlive(existing)) {
        login(existing);
        setStatus('Session restored.', 'ok');
      }
    } catch (_) {}

    refreshFab();

    window.ONYXAuth.openSenpaPanel = open;
    window.ONYXAuth.closeSenpaPanel = close;
  }

  window.ONYXAuth = {
    getSenpaToken: getToken,
    getSenpaAuthPacket: function () {
      var t = getToken();
      return t ? { type: 'auth', token: t } : null;
    },
    isSenpaAuthenticated: function () {
      return !!(getToken() && isJwtAlive(getToken()));
    },
    login: login,
    logout: logout,
    openSenpaPanel: function () {},
    closeSenpaPanel: function () {},
    HELPER: HELPER
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
