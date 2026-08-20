/**
 * ONYX theme/HUD helper. Does not replace PIXI, steal PLAY, or open a 2d canvas.
 * deo.onyx owns #canvas, menus, and #button-play.
 */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function hideLoadersSoon() {
    var a = $('loading-screen');
    var b = $('fake-loading-screen');
    if (a) {
      a.style.display = 'block';
      setTimeout(function () { a.style.display = 'none'; }, 1100);
    }
    if (b) b.style.display = 'none';
  }

  function lockTheme() {
    if (document.getElementById('onyx-theme-lock')) return;
    var style = document.createElement('style');
    style.id = 'onyx-theme-lock';
    style.textContent = [
      'html,body{background:#05060c!important}',
      '#canvas{display:block!important;z-index:3!important}',
      '#gameCanvas{display:none!important}',
      '#huds,#leaderboard-hud,#stats-hud,#minimap-hud{z-index:120!important;pointer-events:none}',
      '#leaderboard-hud{display:block!important}',
      'iframe,#google_ads_iframe,#ad_position_box,.ad-container,[id*="adinplay"],[class*="ad-manager"]{display:none!important}',
      'ins.adsbygoogle,.pub_300x250,.pub_300x250m,.pub_728x90{display:none!important}',
      '#leaderboard-positions .lb-position{display:flex!important;justify-content:flex-end;gap:8px}',
      '#leaderboard-positions span[lbdata=mass]{display:inline!important;color:#e0a82e;font-weight:700}',
      '#menu-overlay{z-index:200!important}',
      '#settings,#theme,#inputs{z-index:220!important;pointer-events:auto}',
      '#onyx-status-chip{position:fixed;top:12px;right:12px;z-index:230;padding:6px 12px;border-radius:999px;background:rgba(15,19,32,.86);border:1px solid rgba(34,211,238,.35);color:#22d3ee;font:700 12px Rajdhani,Segoe UI,sans-serif;letter-spacing:.08em}',
      '#onyx-screenshot-btn{position:fixed;top:48px;right:12px;z-index:230;padding:7px 12px;border:1px solid rgba(224,168,46,.55);border-radius:8px;background:rgba(15,19,32,.92);color:#f5d37a;font:700 12px Segoe UI,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25)}',
      '#onyx-screenshot-btn:hover{background:#2a2630;color:#fff}',
      '#onyx-record-btn{position:fixed;top:84px;right:12px;z-index:230;padding:7px 12px;border:1px solid rgba(255,92,92,.65);border-radius:8px;background:rgba(15,19,32,.92);color:#ff9b9b;font:700 12px Segoe UI,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25)}',
      '#onyx-record-btn.recording{background:#7f1d1d;color:#fff;border-color:#ff5555;animation:onyx-record-pulse 1.2s infinite}',
      '@keyframes onyx-record-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,70,70,.35)}50%{box-shadow:0 0 0 7px rgba(255,70,70,0)}}',
      'iframe[src*="adinplay"],iframe[src*="doubleclick"],iframe[src*="prebid"]{display:none!important}'
    ].join('');
    document.head.appendChild(style);
    var head = $('leaderboard-head');
    if (head) {
      head.textContent = 'ONYX';
      head.style.color = '#e0a82e';
    }
    if (!document.getElementById('onyx-status-chip')) {
      var chip = document.createElement('div');
      chip.id = 'onyx-status-chip';
      chip.textContent = '● ONYX';
      document.body.appendChild(chip);
    }
  }

  function ensureViewport() {
    try {
      document.documentElement.style.width = '100%';
      document.documentElement.style.height = '100%';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      document.body.style.margin = '0';
      var canvas = $('canvas');
      if (canvas) {
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.display = 'block';
      }
      var gameCanvas = $('gameCanvas');
      if (gameCanvas) {
        gameCanvas.style.width = '100vw';
        gameCanvas.style.height = '100vh';
      }
      global.dispatchEvent(new Event('resize'));
      setTimeout(function () { global.dispatchEvent(new Event('resize')); }, 250);
      setTimeout(function () { global.dispatchEvent(new Event('resize')); }, 1000);
    } catch (_) {}
  }

  function ensureMenuVisible() {
    var menu = $('menu-overlay');
    if (!menu) return;
    if (getComputedStyle(menu).display === 'none') menu.style.display = 'block';
    menu.style.visibility = 'visible';
    menu.style.opacity = '1';
  }

  function ensureLoginButton() {
    // Delta FFAEU2 is guest-only; do not inject any login control.
    var login = $('onyx-jwt-login') || $('button-login');
    if (login && login.parentNode) login.parentNode.removeChild(login);
  }

  function ensureScreenshotButton() {
    if ($('onyx-screenshot-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'onyx-screenshot-btn';
    btn.type = 'button';
    btn.textContent = 'Screenshot';
    btn.title = 'Save a screenshot of the game canvas';
    btn.addEventListener('click', function () {
      var canvas = $('canvas') || $('gameCanvas');
      if (!canvas || !canvas.toBlob) {
        if (global.ONYXUi && global.ONYXUi.setStatus) global.ONYXUi.setStatus('Screenshot unavailable');
        return;
      }
      btn.disabled = true;
      var oldText = btn.textContent;
      btn.textContent = 'Saving...';
      canvas.toBlob(function (blob) {
        btn.disabled = false;
        btn.textContent = oldText;
        if (!blob) {
          if (global.ONYXUi && global.ONYXUi.setStatus) global.ONYXUi.setStatus('Screenshot blocked by browser');
          return;
        }
        var now = new Date();
        var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'onyx-screenshot-' + stamp + '.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        if (global.ONYXUi && global.ONYXUi.setStatus) global.ONYXUi.setStatus('Screenshot saved');
      }, 'image/png');
    });
    document.body.appendChild(btn);
  }

  function ensureRecorderButton() {
    if ($('onyx-record-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'onyx-record-btn';
    btn.type = 'button';
    btn.textContent = 'Start Recording';
    btn.title = 'Record a video clip of the game canvas';
    var recorder = null;
    var chunks = [];

    function chooseMime() {
      var types = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
      ];
      for (var i = 0; i < types.length; i++) {
        if (global.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
      }
      return '';
    }

    function setStatus(text) {
      if (global.ONYXUi && global.ONYXUi.setStatus) global.ONYXUi.setStatus(text);
    }

    function stopRecording() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    btn.addEventListener('click', function () {
      var canvas = $('canvas') || $('gameCanvas');
      if (!canvas || !canvas.captureStream || !global.MediaRecorder) {
        setStatus('Video recording unavailable');
        return;
      }
      if (recorder && recorder.state === 'recording') {
        stopRecording();
        return;
      }
      var mime = chooseMime();
      try {
        var stream = canvas.captureStream(60);
        recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 })
          : new MediaRecorder(stream);
      } catch (err) {
        setStatus('Could not start recording');
        return;
      }
      chunks = [];
      recorder.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', function () {
        var blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'onyx-clip-' + new Date().toISOString().replace(/[:.]/g, '-') + '.webm';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        btn.classList.remove('recording');
        btn.textContent = 'Start Recording';
        setStatus('Video saved');
        recorder = null;
        chunks = [];
      });
      recorder.addEventListener('error', function () {
        btn.classList.remove('recording');
        btn.textContent = 'Start Recording';
        setStatus('Recording error');
        recorder = null;
        chunks = [];
      });
      recorder.start(1000);
      btn.classList.add('recording');
      btn.textContent = 'Stop Recording';
      setStatus('Recording...');
    });
    document.body.appendChild(btn);
  }

  function bind() {
    hideLoadersSoon();
    lockTheme();
    ensureViewport();
    ensureMenuVisible();
    ensureLoginButton();
    ensureScreenshotButton();
    ensureRecorderButton();
    console.log('[UI] ONYX READY');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  global.ONYXUi = {
    showMenu: function () { var m = $('menu-overlay'); if (m) m.style.display = 'block'; },
    hideMenu: function () { var m = $('menu-overlay'); if (m) m.style.display = 'none'; },
    closePanels: function () {},
    updateLeaderboard: function () {},
    updateStats: function () {},
    setStatus: function (text) {
      var chip = document.getElementById('onyx-status-chip');
      if (chip) chip.textContent = text || '● ONYX';
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
