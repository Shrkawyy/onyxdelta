// ==UserScript==
// @name         KaterOnyx FFA for Senpa
// @namespace    https://kateronyx.local/ffa
// @version      2.1.0
// @description  Loads the full ONYX engine (deo.onyx + PIXI + WASM create) on Senpa's official origin.
// @author       KaterOnyx
// @match        https://senpa.io/*
// @match        https://www.senpa.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      127.0.0.1
// @connect      localhost
// @connect      192.168.1.6
// @connect      pixijs.download
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @connect      cdn.rawgit.com
// @connect      *
// @updateURL    https://onyx-og.vercel.app/kateronyx.user.js
// @downloadURL  https://onyx-og.vercel.app/kateronyx.user.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var DEFAULT_BASE_URL = 'https://onyx-og.vercel.app/';
  var CLIENT_FILE = 'index.html';
  var VERSION = '2.1.0';
  var MOUNT_KEY = 'kateronyx:mounting';
  var LICENSE_KEY = 'tm_key';
  var LICENSE_VERIFY_URL = 'https://onyxadmin-npam4ilu.manus.space/api/verify-key';
  var LOCAL_CSS = [
    'assets/css/albion.css',
    'assets/css/onyx-theme.css',
    'assets/css/ryuten-theme.css'
  ];
  var CDN_SCRIPTS = [
    ['https://pixijs.download/v5.2.0/pixi.min.js', 'pixi.min.js'],
    ['https://cdn.jsdelivr.net/npm/pixi-filters@2.7.1/dist/pixi-filters.js', 'pixi-filters.js'],
    ['https://unpkg.com/tippy.js@2.0.4/dist/tippy.all.min.js', 'tippy.all.min.js'],
    ['https://cdn.rawgit.com/dcodeIO/protobuf.js/6.8.8/dist/protobuf.min.js', 'protobuf.min.js']
  ];

  function isLocalHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  }

  function normalizeBaseUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) return DEFAULT_BASE_URL;
      return url.href.endsWith('/') ? url.href : url.href + '/';
    } catch (_) {
      return DEFAULT_BASE_URL;
    }
  }

  function getBaseUrl() {
    var override = '';
    try { override = localStorage.getItem('kateronyx:base-url') || ''; } catch (_) {}
    return normalizeBaseUrl(override || DEFAULT_BASE_URL);
  }

  function srcOf(el) {
    return (el && (el.src || el.href || el.getAttribute && (el.getAttribute('src') || el.getAttribute('href')))) || '';
  }

  var SENPA_AD = /adinplay|ad-manager|prebid|doubleclick|googlesyndication|googleadservices|adsbygoogle|amazon-adsystem|imasdk|tag\.min\.js|pagead2|securepubads|adnxs|rubiconproject|pubmatic|openx|criteo|id5-sync|adsystem|advertising\.com/i;

  function isAllowedKeep(src) {
    if (!src) return false;
    if (src.indexOf('blob:') === 0) return true;
    if (src.indexOf('kateronyx') !== -1) return true;
    if (/challenges\.cloudflare\.com/i.test(src)) return true;
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.fontawesome\.com/i.test(src)) return true;
    if (/pixijs\.download|cdn\.jsdelivr\.net\/npm\/pixi-filters|unpkg\.com\/tippy|cdn\.rawgit\.com\/dcodeIO\/protobuf/i.test(src)) return true;
    return false;
  }

  function killSenpaRuntime() {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          for (var i = 0; i < regs.length; i++) regs[i].unregister();
          if (regs.length) console.log('[ONYX] SENPA_SW_REMOVED', regs.length);
        }).catch(function () {});
        try {
          Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            get: function () { return undefined; }
          });
        } catch (_) {
          if (navigator.serviceWorker.register) {
            navigator.serviceWorker.register = function () {
              return Promise.reject(new Error('ONYX blocked service worker'));
            };
          }
        }
      }
    } catch (_) {}
    try {
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) {
          for (var i = 0; i < keys.length; i++) caches.delete(keys[i]);
        }).catch(function () {});
      }
    } catch (_) {}

    function blockScriptSrc(el, url) {
      if (isAllowedKeep(url)) return false;
      try { el.type = 'javascript/blocked'; } catch (_) {}
      try { el.removeAttribute('src'); } catch (_) {}
      console.log('[ONYX] BLOCKED_SCRIPT', String(url || 'inline').slice(0, 120));
      return true;
    }

    try {
      var proto = HTMLScriptElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'src') ||
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src');
      if (desc && desc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (value) {
            if (blockScriptSrc(this, String(value || ''))) return;
            return desc.set.call(this, value);
          }
        });
      }
    } catch (_) {}

    try {
      var create = Document.prototype.createElement;
      Document.prototype.createElement = function (name, opts) {
        var el = create.call(this, name, opts);
        var tag = String(name || '').toLowerCase();
        if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
          var kill = function () {
            var src = el.src || el.getAttribute && (el.getAttribute('src') || el.getAttribute('data')) || '';
            if (SENPA_AD.test(src) || /senpa\.io/i.test(src) && !isAllowedKeep(src)) {
              el.remove();
              console.log('[ONYX] BLOCKED_FRAME', String(src).slice(0, 80));
            }
          };
          el.addEventListener('load', kill, true);
          setTimeout(kill, 0);
        }
        return el;
      };
    } catch (_) {}
  }

  function isOfficialRuntimeNode(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    var src = srcOf(el);
    if (isAllowedKeep(src)) return false;
    if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') return true;
    if (tag === 'LINK') {
      var rel = (el.rel || '').toLowerCase();
      if (rel === 'modulepreload' || rel === 'preload' || rel === 'module') return true;
      if (/main-|adinplay|prebid|ad-manager|senpa|tag\.min/i.test(src)) return true;
    }
    if (tag === 'CANVAS' && el.id !== 'gameCanvas' && el.id !== 'canvas' && el.id !== 'minimap-nodes') return true;
    return false;
  }

  function stripOfficial(root) {
    if (!root || root.nodeType !== 1) return;
    if (isOfficialRuntimeNode(root)) {
      root.remove();
      return;
    }
    var nodes = root.querySelectorAll('script,iframe,embed,object,link[rel="modulepreload"],link[rel="preload"],link[rel="module"]');
    for (var i = 0; i < nodes.length; i++) {
      if (isOfficialRuntimeNode(nodes[i])) nodes[i].remove();
    }
  }

  function seizePage() {
    try { window.stop(); } catch (_) {}
    try {
      document.open();
      document.write('<!doctype html><html><head><meta charset="utf-8"><title>ONYX</title></head><body></body></html>');
      document.close();
    } catch (_) {
      try {
        if (document.documentElement) document.documentElement.innerHTML = '<head></head><body></body>';
      } catch (__) {}
    }
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) stripOfficial(added[j]);
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      stripOfficial(document.documentElement);
    }
    window.addEventListener('beforescriptexecute', function (ev) {
      var src = ev.target && ev.target.src;
      if (!isAllowedKeep(src || 'inline-blocked')) ev.preventDefault();
    }, true);
    return observer;
  }

  function renderLoading() {
    var style = document.createElement('style');
    style.id = 'kateronyx-loading-style';
    style.textContent =
      'html{background:#05060c!important}' +
      'body{visibility:hidden!important}' +
      "html::before{content:'Loading ONYX...';position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:#05060c;color:#22d3ee;font:700 18px Rajdhani,system-ui,sans-serif;letter-spacing:.2em;visibility:visible}";
    (document.head || document.documentElement).appendChild(style);
  }

  function readLicenseKey() {
    try { return (localStorage.getItem(LICENSE_KEY) || '').trim(); } catch (_) { return ''; }
  }
  function saveLicenseKey(key) {
    try { localStorage.setItem(LICENSE_KEY, key); } catch (_) {}
  }
  function clearLicenseKey() {
    try { localStorage.removeItem(LICENSE_KEY); } catch (_) {}
  }
  function verifyLicenseKey(key) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LICENSE_VERIFY_URL,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        data: JSON.stringify({ key: key }),
        timeout: 15000,
        onload: function (response) {
          var data = {};
          try { data = JSON.parse(response.responseText || '{}'); } catch (_) {}
          if (response.status >= 200 && response.status < 300 && data.ok) {
            resolve(true);
            return;
          }
          reject(new Error(data.error || 'المفتاح غير صحيح أو منتهي الصلاحية.'));
        },
        onerror: function () { reject(new Error('تعذر الاتصال بخادم التحقق من المفتاح.')); },
        ontimeout: function () { reject(new Error('انتهت مهلة التحقق من المفتاح.')); }
      });
    });
  }
  function requestLicense() {
    var existing = readLicenseKey();
    if (existing) {
      return verifyLicenseKey(existing).catch(function () {
        clearLicenseKey();
        return openLicenseDialog('المفتاح المحفوظ غير صالح؛ أدخل مفتاحًا جديدًا.');
      });
    }
    return openLicenseDialog('أدخل مفتاح الدخول للمتابعة.');
  }
  function openLicenseDialog(initialMessage) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      var style = document.createElement('style');
      var panel = document.createElement('section');
      var title = document.createElement('h1');
      var subtitle = document.createElement('p');
      var form = document.createElement('form');
      var input = document.createElement('input');
      var actions = document.createElement('div');
      var submit = document.createElement('button');
      var status = document.createElement('p');
      style.textContent =
        '#kateronyx-license-gate{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;padding:20px;background:rgba(5,6,12,.97);color:#e8eef6;font:16px/1.5 system-ui,sans-serif;visibility:visible!important}' +
        '#kateronyx-license-gate .license-panel{width:min(440px,100%);padding:30px;border:1px solid #29445c;border-radius:18px;background:linear-gradient(145deg,#111b2a,#0a101a);box-shadow:0 20px 80px rgba(0,0,0,.55);text-align:center}' +
        '#kateronyx-license-gate h1{margin:0 0 8px;color:#49dcff;font-size:30px;letter-spacing:.08em}' +
        '#kateronyx-license-gate .license-subtitle{margin:0 0 22px;color:#9db0c3}' +
        '#kateronyx-license-gate input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #35526b;border-radius:9px;background:#070c13;color:#fff;font:inherit;outline:none;text-align:center}' +
        '#kateronyx-license-gate input:focus{border-color:#49dcff;box-shadow:0 0 0 3px rgba(73,220,255,.14)}' +
        '#kateronyx-license-gate .license-actions{display:flex;gap:10px;margin-top:14px}' +
        '#kateronyx-license-gate button{flex:1;padding:12px;border:0;border-radius:9px;background:linear-gradient(135deg,#49dcff,#2389ff);color:#00131b;font:800 15px system-ui,sans-serif;cursor:pointer}' +
        '#kateronyx-license-gate .license-status{min-height:24px;margin:14px 0 0;color:#ffbe55;font-size:13px}' +
        '#kateronyx-license-gate .license-status.error{color:#ff7187}';
      overlay.id = 'kateronyx-license-gate';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      panel.className = 'license-panel';
      title.textContent = 'ONYX ACCESS';
      subtitle.className = 'license-subtitle';
      subtitle.textContent = 'المفتاح مطلوب لتشغيل الإضافة.';
      input.type = 'password';
      input.name = 'license-key';
      input.autocomplete = 'off';
      input.placeholder = 'License key';
      input.required = true;
      submit.type = 'submit';
      submit.textContent = 'VERIFY KEY';
      status.className = 'license-status';
      status.textContent = initialMessage || '';
      actions.className = 'license-actions';
      actions.appendChild(submit);
      form.appendChild(input);
      form.appendChild(actions);
      panel.appendChild(title);
      panel.appendChild(subtitle);
      panel.appendChild(form);
      panel.appendChild(status);
      overlay.appendChild(style);
      overlay.appendChild(panel);
      (document.body || document.documentElement).appendChild(overlay);
      input.focus();
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var key = input.value.trim();
        if (!key) {
          status.className = 'license-status error';
          status.textContent = 'اكتب المفتاح أولًا.';
          input.focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = 'CHECKING...';
        status.className = 'license-status';
        status.textContent = 'جارٍ التحقق من المفتاح...';
        verifyLicenseKey(key).then(function () {
          saveLicenseKey(key);
          overlay.remove();
          resolve(true);
        }).catch(function (error) {
          submit.disabled = false;
          submit.textContent = 'VERIFY KEY';
          status.className = 'license-status error';
          status.textContent = error && error.message ? error.message : 'فشل التحقق من المفتاح.';
          input.select();
        });
      });
    });
  }

  function renderError(message) {
    window.stop();
    document.title = 'KaterOnyx load error';
    var head = document.createElement('head');
    var body = document.createElement('body');
    var style = document.createElement('style');
    var box = document.createElement('div');
    var title = document.createElement('h1');
    var detail = document.createElement('p');
    var help = document.createElement('p');
    var reload = document.createElement('button');
    style.textContent = 'html,body{height:100%;margin:0;background:#090b10;color:#e8eef6;font:16px system-ui,sans-serif}body{display:grid;place-items:center}.box{max-width:640px;padding:30px;border:1px solid #2a3645;border-radius:14px;background:#111721}h1{margin-top:0;color:#ff647c}button{padding:10px 16px;border:0;border-radius:8px;cursor:pointer}code{color:#7de8ff}';
    box.className = 'box';
    title.textContent = 'KaterOnyx could not load';
    detail.textContent = String(message);
    help.innerHTML = 'Serve the KaterOnyx folder (<code>npx serve -p 4173</code>), then set <code>localStorage.setItem("kateronyx:base-url","http://127.0.0.1:4173/")</code> on this page if needed.';
    reload.textContent = 'Reload';
    reload.addEventListener('click', function () { location.reload(); });
    box.append(title, detail, help, reload);
    head.appendChild(style);
    body.appendChild(box);
    document.documentElement.replaceChildren(head, body);
  }

  function gmGet(url, responseType) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: responseType || 'text',
        timeout: 30000,
        headers: { 'Cache-Control': 'no-cache' },
        onload: function (response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(url + ' HTTP ' + response.status));
            return;
          }
          resolve(response.response);
        },
        onerror: function () { reject(new Error('Request failed: ' + url)); },
        ontimeout: function () { reject(new Error('Request timed out: ' + url)); }
      });
    });
  }

  function rewriteAssets(doc, baseUrl) {
    var nodes = doc.querySelectorAll('[href],[src]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var attr = el.hasAttribute('src') ? 'src' : 'href';
      var value = el.getAttribute(attr);
      if (!value) continue;
      if (el.tagName === 'LINK' && /stylesheet/i.test(el.rel || '')) continue;
      if (/senpa\.io/i.test(value) && /ryuten|iconfont|\.woff/i.test(value)) {
        try {
          var name = new URL(value, 'https://senpa.io/').pathname.split('/').pop();
          el.setAttribute(attr, new URL('assets/ryuten/' + name, baseUrl).href);
        } catch (_) {}
        continue;
      }
      if (/^(https?:|data:|blob:|#|\/\/)/i.test(value)) continue;
      el.setAttribute(attr, new URL(value, baseUrl).href);
    }
  }

  function rewriteCssUrls(css, baseUrl, fontBlobUrl) {
    return String(css || '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (full, _q, raw) {
      var url = String(raw || '').trim();
      if (!url || /^(data:|blob:|#)/i.test(url)) return full;
      if (/iconfont|\.woff2?(?:$|\?)/i.test(url) && fontBlobUrl) {
        return 'url(' + JSON.stringify(fontBlobUrl) + ')';
      }
      if (/^(https?:|\/\/)/i.test(url)) {
        if (/senpa\.io/i.test(url) && /ryuten|iconfont|\.woff/i.test(url)) {
          try {
            var abs = url.indexOf('//') === 0 ? 'https:' + url : url;
            var file = new URL(abs).pathname.split('/').pop();
            return 'url(' + JSON.stringify(new URL('assets/ryuten/' + file, baseUrl).href) + ')';
          } catch (_) { return full; }
        }
        return full;
      }
      try {
        return 'url(' + JSON.stringify(new URL(url, baseUrl + 'assets/css/').href) + ')';
      } catch (_) { return full; }
    });
  }

  function inlineLocalStyles(doc, cssMap) {
    var links = Array.prototype.slice.call(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href') || '';
      var key = '';
      for (var k = 0; k < LOCAL_CSS.length; k++) {
        if (href.indexOf(LOCAL_CSS[k]) !== -1) { key = LOCAL_CSS[k]; break; }
      }
      if (!key) continue;
      var style = doc.createElement('style');
      style.setAttribute('data-onyx-css', key);
      style.textContent = cssMap[key] || '';
      link.replaceWith(style);
    }
  }

  function injectScript(text, label) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([text + '\n//# sourceURL=kateronyx://' + label], { type: 'text/javascript' });
      var script = document.createElement('script');
      script.src = URL.createObjectURL(blob);
      script.addEventListener('load', function () { resolve(); }, { once: true });
      script.addEventListener('error', function () { reject(new Error('inject failed: ' + label)); }, { once: true });
      document.body.appendChild(script);
    });
  }

  function wasmHookSource(gameBlob, fsBlob, fontBlob, baseUrl) {
    return (
      'window.__KATERONYX_USERSCRIPT__=true;' +
      'window.__KATERONYX_BASE_URL=' + JSON.stringify(baseUrl) + ';' +
      'window.__KATERONYX_WASM_BLOB__=' + JSON.stringify(gameBlob) + ';' +
      'window.__KATERONYX_WASM89_BLOB__=' + JSON.stringify(fsBlob) + ';' +
      'window.__KATERONYX_FONT_BLOB__=' + JSON.stringify(fontBlob || '') + ';' +
      'window.k=window.k||{};' +
      'window.k.locateFile=function(name){' +
      'name=String(name||"");' +
      'if(/89\\.wasm/i.test(name)&&!/899\\.wasm/i.test(name)) return window.__KATERONYX_WASM89_BLOB__;' +
      'return window.__KATERONYX_WASM_BLOB__;};' +
      '(function(){' +
      'function hrefOf(input){' +
      'if(!input) return "";' +
      'if(typeof input==="string") return input;' +
      'if(typeof URL!=="undefined"&&input instanceof URL) return String(input);' +
      'if(typeof Request!=="undefined"&&input instanceof Request) return input.url||"";' +
      'return (input&&input.url)||String(input);}' +
      'function isFsWasm(url){return /(?:^|[\\/]|%2F)89\\.wasm(?:\\?|$)/i.test(url)&&!/899\\.wasm/i.test(url);}' +
      'function isGameWasm(url){return /bundle2?\\.wasm|899\\.wasm/i.test(url);}' +
      'function isAnyWasm(url){return /\\.wasm(?:\\?|$)/i.test(url)||isGameWasm(url)||isFsWasm(url);}' +
      'function looksHtmlUrl(url){return /senpa\\.io/i.test(url)&&!/^blob:/i.test(url);}' +
      'function mapWasm(url){' +
      'if(!url||/^blob:/i.test(url)||!isAnyWasm(url)) return null;' +
      'if(isFsWasm(url)) return window.__KATERONYX_WASM89_BLOB__;' +
      'return window.__KATERONYX_WASM_BLOB__;}' +
      'function mapFont(url){' +
      'if(!url||!window.__KATERONYX_FONT_BLOB__) return null;' +
      'if(/senpa\\.io/i.test(url)&&( /iconfont|\\/ryuten\\/|\\.woff2?(?:\\?|$)/i.test(url))) return window.__KATERONYX_FONT_BLOB__;' +
      'return null;}' +
      'function logRewrite(kind,url){' +
      'if(window.__KATERONYX_REWRITE_LOGGED__) return;' +
      'window.__KATERONYX_REWRITE_LOGGED__=true;' +
      'console.log("[ONYX-ENGINE] "+kind+" fetch rewritten from HTML-looking url", String(url).slice(0,96));}' +
      'var nativeFetch=window.fetch;' +
      'if(nativeFetch){window.fetch=function(input,init){' +
      'var url=hrefOf(input);' +
      'var wasm=mapWasm(url);' +
      'if(wasm){' +
      'if(!window.__KATERONYX_WASM_USED_LOGGED__){window.__KATERONYX_WASM_USED_LOGGED__=true;console.log("[ONYX-ENGINE] wasm blob used");}' +
      'if(looksHtmlUrl(url)) logRewrite("wasm",url);' +
      'return nativeFetch.call(this,wasm,init);}' +
      'var font=mapFont(url);' +
      'if(font){if(looksHtmlUrl(url)) logRewrite("font",url);return nativeFetch.call(this,font,init);}' +
      'return nativeFetch.apply(this,arguments);};}' +
      'var open=XMLHttpRequest.prototype.open;' +
      'XMLHttpRequest.prototype.open=function(method,url){' +
      'if(typeof url==="string"){' +
      'var wasm=mapWasm(url);' +
      'if(wasm){if(!window.__KATERONYX_WASM_USED_LOGGED__){window.__KATERONYX_WASM_USED_LOGGED__=true;console.log("[ONYX-ENGINE] wasm blob used");}if(looksHtmlUrl(url)) logRewrite("wasm",url);arguments[1]=wasm;}' +
      'else{var font=mapFont(url);if(font){if(looksHtmlUrl(url)) logRewrite("font",url);arguments[1]=font;}}' +
      '}' +
      'return open.apply(this,arguments);};' +
      'if(typeof WebAssembly!=="undefined"&&WebAssembly.instantiateStreaming){' +
      'var nativeIS=WebAssembly.instantiateStreaming.bind(WebAssembly);' +
      'WebAssembly.instantiateStreaming=function(source,imports){' +
      'return Promise.resolve(source).then(function(src){' +
      'var url=(src&&src.url)||"";' +
      'var wasm=mapWasm(url);' +
      'if(wasm){if(looksHtmlUrl(url)) logRewrite("wasm",url);return nativeFetch.call(window,wasm).then(function(res){return nativeIS(res,imports);});}' +
      'return nativeIS(src,imports);});};}' +
      '})();' +
      'console.log("[ONYX] BOOT");' +
      'console.log("[ONYX-ENGINE] wasm blobs ready (game+89, not wasmLoader.js)");' +
      'console.log("[ONYX] SENPA_GAME_BLOCKED = true");' +
      'console.log("[ONYX] THEME_INLINED = true");'
    );
  }

  async function mount(baseUrl) {
    if (window.__KATERONYX_MOUNTED__) return;
    window.__KATERONYX_MOUNTED__ = true;

    var cssGets = LOCAL_CSS.map(function (file) {
      return gmGet(baseUrl + file + '?v=' + encodeURIComponent(VERSION)).then(function (css) {
        return [file, css];
      });
    });

    var v = encodeURIComponent(VERSION);
    var html = await gmGet(baseUrl + CLIENT_FILE + '?v=' + v);
    var wasm = await gmGet(baseUrl + '899.wasm?v=' + v, 'arraybuffer');
    var wasm89 = await gmGet(baseUrl + '89.wasm?v=' + v, 'arraybuffer');
    var fontBuf = null;
    try { fontBuf = await gmGet(baseUrl + 'assets/ryuten/iconfont.woff?v=' + v, 'arraybuffer'); } catch (err) {
      console.warn('[ONYX] iconfont.woff skipped', err && err.message || err);
    }
    var libJs = await gmGet(baseUrl + 'assets/js/lib.js?v=' + v);
    var runtimeJs = await gmGet(baseUrl + 'assets/js/runtime.58908f3dbdb804a00215.js?v=' + v);
    var vendorsJs = await gmGet(baseUrl + 'assets/js/vendors.c173b9063bd6941f8bc0.js?v=' + v);
    var authJs = await gmGet(baseUrl + 'onyx-senpa-auth.js?v=' + v);
    var customJs = await gmGet(baseUrl + 'onyx-custom.js?v=' + v);
    var soundsJs = await gmGet(baseUrl + 'assets/js/ryuten-sounds.js?v=' + v);
    var deoJs = await gmGet(baseUrl + 'deo.onyx.beautified.js?v=' + v);
    var extrasJs = await gmGet(baseUrl + 'assets/js/ryuten-extras.js?v=' + v);
    var adapterJs = await gmGet(baseUrl + 'onyx-ffa-adapter.js?v=' + v);
    var uiJs = await gmGet(baseUrl + 'onyx-ui.js?v=' + v);

    var cdnTexts = await Promise.all(CDN_SCRIPTS.map(function (item) {
      return gmGet(item[0]).then(function (text) {
        return [item[1], text];
      }).catch(function (err) {
        throw new Error('CDN script failed (' + item[1] + '): ' + (err && err.message || err));
      });
    }));

    var cssPairs = await Promise.all(cssGets);
    var fontBlob = fontBuf ? URL.createObjectURL(new Blob([fontBuf], { type: 'font/woff' })) : '';
    var cssMap = {};
    for (var i = 0; i < cssPairs.length; i++) {
      cssMap[cssPairs[i][0]] = rewriteCssUrls(cssPairs[i][1], baseUrl, fontBlob);
    }

    var parsed = new DOMParser().parseFromString(html, 'text/html');
    if (!parsed.head || !parsed.body) throw new Error('index.html is not a complete HTML document.');
    parsed.querySelectorAll('script').forEach(function (node) { node.remove(); });
    rewriteAssets(parsed, baseUrl);
    inlineLocalStyles(parsed, cssMap);

    window.stop();
    var newHead = document.importNode(parsed.head, true);
    var newBody = document.importNode(parsed.body, true);
    document.documentElement.lang = parsed.documentElement.lang || 'en';
    document.documentElement.replaceChildren(newHead, newBody);
    document.title = 'ONYX';
    document.documentElement.querySelectorAll('iframe,embed,object').forEach(function (node) { node.remove(); });
    console.log('[ONYX] SENPA_ADS_BLOCKED = true');

    var wasmBlob = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    var wasm89Blob = URL.createObjectURL(new Blob([wasm89], { type: 'application/wasm' }));
    await injectScript(
      'window.__JAXXV6_USERSCRIPT__=false;' +
      wasmHookSource(wasmBlob, wasm89Blob, fontBlob, baseUrl),
      'bootstrap.js'
    );

    for (var p = 0; p < cdnTexts.length; p++) {
      await injectScript(cdnTexts[p][1], cdnTexts[p][0]);
    }
    await injectScript(libJs, 'lib.js');
    await injectScript(authJs, 'onyx-senpa-auth.js');
    await injectScript(runtimeJs, 'runtime.js');
    await injectScript(vendorsJs, 'vendors.js');
    await injectScript(customJs, 'onyx-custom.js');
    await injectScript(soundsJs, 'ryuten-sounds.js');
    await injectScript(adapterJs, 'onyx-ffa-adapter.js');
    await injectScript(deoJs, 'deo.onyx.beautified.js');
    await injectScript(extrasJs, 'ryuten-extras.js');
    await injectScript(uiJs, 'onyx-ui.js');
    await injectScript(
      'console.log("[ONYX-ENGINE] deo/PIXI injected, wasmLoader=" + !!(window.wasmLoader||window.A));',
      'onyx-runtime-init.js'
    );
    try { sessionStorage.removeItem(MOUNT_KEY); } catch (_) {}
  }

  killSenpaRuntime();
  seizePage();
  var baseUrl = getBaseUrl();
  renderLoading();
  requestLicense().then(function () {
    mount(baseUrl).catch(function (error) {
      renderError(error && error.message ? error.message : error);
    });
  }).catch(function (error) {
    renderError(error && error.message ? error.message : error);
  });
})();
