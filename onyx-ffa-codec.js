/**
 * In-page FFA codec for the Senpa userscript host.
 * Runs wasmLoader + bundle.wasm in the senpa.io window (same as OG),
 * without Jaxx bundle.js / window.app / lobby.
 */
(function (global) {
  'use strict';

  var factories = Object.create(null);
  var installed = Object.create(null);

  function requireFactory(id) {
    if (installed[id]) return installed[id].exports;
    var factory = factories[id];
    if (!factory) throw new Error('FFA codec: webpack module ' + id + ' missing');
    var module = installed[id] = { id: id, exports: {} };
    factory.call(module.exports, module, module.exports, requireFactory);
    return module.exports;
  }

  requireFactory.d = function (exports, definition) {
    for (var key in definition) {
      if (Object.prototype.hasOwnProperty.call(definition, key)) {
        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
      }
    }
  };
  requireFactory.r = function () {};
  requireFactory.n = function (mod) {
    var getter = function () { return mod && mod.__esModule ? mod.default : mod; };
    requireFactory.d(getter, { a: getter });
    return getter;
  };
  requireFactory.o = function (obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  };

  if (!global.webpackChunkeon_client) global.webpackChunkeon_client = [];
  var origPush = global.webpackChunkeon_client.push.bind(global.webpackChunkeon_client);
  global.webpackChunkeon_client.push = function (chunk) {
    if (chunk && chunk[1]) {
      var mods = chunk[1];
      for (var id in mods) {
        if (Object.prototype.hasOwnProperty.call(mods, id)) factories[id] = mods[id];
      }
    }
    return origPush(chunk);
  };

  if (global.webpackChunkeon_client.length) {
    for (var i = 0; i < global.webpackChunkeon_client.length; i++) {
      var existing = global.webpackChunkeon_client[i];
      if (existing && existing[1]) {
        var existingMods = existing[1];
        for (var existingId in existingMods) {
          if (Object.prototype.hasOwnProperty.call(existingMods, existingId)) {
            factories[existingId] = existingMods[existingId];
          }
        }
      }
    }
  }

  function wasmBytes() {
    if (global.__KATERONYX_WASM_BYTES__) return global.__KATERONYX_WASM_BYTES__;
    if (global.__KATERONYX_WASM_B64__) {
      var bin = atob(global.__KATERONYX_WASM_B64__);
      var u8 = new Uint8Array(bin.length);
      for (var n = 0; n < bin.length; n++) u8[n] = bin.charCodeAt(n);
      global.__KATERONYX_WASM_BYTES__ = u8;
      return u8;
    }
    return null;
  }

  var wasmFactory;
  try {
    wasmFactory = requireFactory(458).A;
  } catch (err) {
    console.error('[FFA ERROR] CODEC_FAILED', 'wasmLoader export A: ' + (err && err.message || err));
    return;
  }

  var moduleInstance = null;
  var socket = null;
  var handlers = {
    onOpen: function () {},
    onClose: function () {},
    onMessage: function () {},
    onError: function () {}
  };

  function loadWasm() {
    var existing = wasmBytes();
    if (existing) return Promise.resolve(existing);
    var url = (global.__KATERONYX_BASE_URL || '') + 'bundle.wasm';
    return fetch(url || 'bundle.wasm').then(function (res) {
      if (!res.ok) throw new Error('bundle.wasm HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      global.__KATERONYX_WASM_BYTES__ = new Uint8Array(buf);
      return global.__KATERONYX_WASM_BYTES__;
    });
  }

  function boot() {
    return loadWasm().catch(function () { return null; }).then(function (bytes) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var config = {
          print: function (msg) { console.log('[FFA]', String(msg)); },
          printErr: function (msg) {
            if (!settled) {
              settled = true;
              reject(new Error(String(msg)));
            }
          },
          onRuntimeInitialized: function () {
            if (!settled) {
              settled = true;
              resolve(moduleInstance);
            }
          }
        };
        if (bytes) {
          config.instantiateWasm = function (info, receiveInstance) {
            WebAssembly.instantiate(bytes, info).then(function (result) {
              receiveInstance(result.instance, result.module);
            }).catch(function (err) {
              if (!settled) {
                settled = true;
                reject(err);
              }
            });
            return {};
          };
        }
        moduleInstance = wasmFactory(config);
      });
    });
  }

  var ready = boot();
  ready.then(function () {
    console.log('[FFA] CODEC_READY');
    console.log('[FFA] ALLOC_READY', typeof (moduleInstance && moduleInstance._alloc));
  }).catch(function (err) {
    console.error('[FFA ERROR] CODEC_FAILED', err && err.message ? err.message : err);
  });

  global.ONYXFfaCodec = {
    ready: ready,
    connect: function (url, next) {
      next = next || {};
      handlers.onOpen = next.onOpen || function () {};
      handlers.onClose = next.onClose || function () {};
      handlers.onMessage = next.onMessage || function () {};
      handlers.onError = next.onError || function () {};
      return ready.then(function () {
        if (!moduleInstance || typeof moduleInstance.create !== 'function') {
          throw new Error('WASM create() missing');
        }
        if (!url || url.indexOf('wss://eu.senpa.io:2001') !== 0) {
          throw new Error('[FFA] Invalid codec URL: ' + url);
        }
        socket = moduleInstance.create(
          url,
          function () { handlers.onOpen(); },
          function (code, reason, wasClean) {
            handlers.onClose({
              code: typeof code === 'number' ? code : (code && code.code),
              reason: String(reason || (code && code.reason) || ''),
              wasClean: !!(wasClean || (code && code.wasClean))
            });
          },
          function (data) {
            var buf;
            if (data && data.buffer && data.byteLength != null) {
              buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            } else if (data instanceof ArrayBuffer) {
              buf = data.slice(0);
            } else {
              return;
            }
            handlers.onMessage(buf);
          },
          function (err) {
            var msg = 'ws error';
            if (err && err.message) msg = err.message;
            else if (err && err.type) msg = 'WebSocket ' + err.type;
            else if (err != null) msg = String(err);
            handlers.onError(msg);
          }
        );
      });
    },
    send: function (bytes) {
      if (!socket) return;
      if (bytes instanceof ArrayBuffer) socket.send(new Uint8Array(bytes));
      else socket.send(bytes);
    },
    alloc: function (code, data) {
      if (!moduleInstance) return false;
      var fn = moduleInstance._alloc || moduleInstance.alloc;
      if (typeof fn !== 'function') {
        console.error('[FFA ERROR] ALLOC_MISSING');
        return false;
      }
      try {
        var payload = data;
        if (payload && payload.buffer && typeof payload.slice === 'function' && !(payload instanceof ArrayBuffer)) {
          payload = payload.slice ? payload.slice() : new Uint8Array(payload);
        }
        fn.call(moduleInstance, code, payload);
        return true;
      } catch (err) {
        console.error('[FFA ERROR] ALLOC_FAILED code=' + code, err && err.message ? err.message : err);
        return false;
      }
    },
    close: function () {
      try { if (socket && socket.close) socket.close(); } catch (_) {}
      socket = null;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
