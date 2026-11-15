/* Vigil web viewer. Runs entirely in this browser: it signs in to Google, then reads and writes
   only the files Vigil itself created in the signed-in person's Google Drive. */
(function () {
  'use strict';

  // The Google sign-in identity for this page (a web client in the same Google project as the app).
  var CLIENT_ID = '482886594552-gacm02fib8gf855rfc3d75ul99cq4obe.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var FIELDS = 'files(id,name,modifiedTime,appProperties,starred,size)';
  var ONLINE_MS = 210000;
  var SYSTEM_FOLDER = 'Vigil system (do not delete)';

  // Everything a camera can report, most important first. Third value marks sounds.
  var TYPES = [
    ['SMOKE_ALARM', 'Smoke or CO alarm', true], ['GLASS_BREAK', 'Glass breaking', true],
    ['TAMPER_MOVED', 'Camera moved', false], ['TAMPER_COVERED', 'Lens covered', false],
    ['PERSON', 'Person', false], ['LINGER', 'Person lingering', false], ['LINE_CROSSED', 'Line crossed', false],
    ['BABY_CRY', 'Baby crying', true], ['SHOUT', 'Shouting', true], ['VEHICLE', 'Vehicle', false],
    ['PET', 'Pet', false], ['DOG_BARK', 'Dog barking', true], ['MOTION_STOPPED', 'Movement stopped', false],
    ['ABSENT', 'Nobody seen', false], ['CAMERA_OFFLINE', 'Camera offline', false],
    ['OVERHEATING', 'Phone overheating', false], ['UNPLUGGED', 'Charger unplugged', false],
    ['LOW_BATTERY', 'Battery low', false], ['LOW_STORAGE', 'Storage nearly full', false], ['MOTION', 'Movement', false]
  ];

  var token = null;
  var tokenClient = null;
  var expiryTimer = null;
  var systemFolderId = null;
  var cameras = [];            // [{id, name, armed, paused, watching, recording, online, seenMs, snapshotFileId, retentionDays}]
  var stillUrls = {};          // cameraId -> object URL of the latest still
  var openId = null;           // the camera being watched, if any
  var live = null;             // the live session for that camera
  var homeTimer = null;
  var alertTimer = null;
  var alertsSince = null;
  var seenAlerts = {};
  var alertLines = {};
  var playing = null;          // {clip, url}

  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).hidden = !on; }
  function text(id, value) { $(id).textContent = value || ''; }
  function el(tag, cls, content) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    return node;
  }
  function wait(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
  function clock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ago(ms) {
    var minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return 'moments ago';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60) return minutes + ' minutes ago';
    if (minutes < 120) return '1 hour ago';
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + ' hours ago';
    return Math.floor(minutes / 1440) + ' days ago';
  }
  function duration(ms) {
    var s = Math.max(1, Math.floor(ms / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function size(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes > 0) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return '';
  }
  function headline(names) {
    for (var i = 0; i < TYPES.length; i++) if (names.indexOf(TYPES[i][0]) >= 0) return TYPES[i];
    return TYPES[TYPES.length - 1];
  }
  function label(name) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i][0] === name) return TYPES[i][1];
    return null;
  }

  // ---------------------------------------------------------------- Google Drive

  function SignedOut() { this.name = 'SignedOut'; }

  async function call(url, options) {
    if (!token) throw new SignedOut();
    options = options || {};
    options.headers = Object.assign({ Authorization: 'Bearer ' + token }, options.headers || {});
    var response = await fetch(url, options);
    if (response.status === 401) {
      signedOut('Your sign-in has run out. Sign in again to carry on.');
      throw new SignedOut();
    }
    if (!response.ok && response.status !== 404) throw new Error('Google Drive said ' + response.status);
    return response;
  }

  function quote(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  /** Vigil's files that carry every one of these private labels. */
  async function find(labels, extra) {
    var q = ['trashed = false'];
    Object.keys(labels).forEach(function (key) {
      q.push("appProperties has { key='" + quote(key) + "' and value='" + quote(labels[key]) + "' }");
    });
    if (extra) q.push(extra);
    var out = [];
    var page = null;
    do {
      var url = API + '/files?pageSize=200&fields=nextPageToken,' + encodeURIComponent(FIELDS) + '&q=' + encodeURIComponent(q.join(' and '));
      if (page) url += '&pageToken=' + encodeURIComponent(page);
      var body = await (await call(url)).json();
      (body.files || []).forEach(function (f) { f.appProperties = f.appProperties || {}; out.push(f); });
      page = body.nextPageToken || null;
    } while (page);
    return out;
  }

  async function readJson(fileId) {
    var response = await call(API + '/files/' + fileId + '?alt=media');
    if (!response.ok) return null;
    try { return await response.json(); } catch (e) { return null; }
  }

  async function readBlob(fileId) {
    var response = await call(API + '/files/' + fileId + '?alt=media');
    if (!response.ok) return null;
    var blob = await response.blob();
    return blob.size > 0 ? blob : null;
  }

  async function remove(fileId) {
    await call(API + '/files/' + fileId, { method: 'DELETE' });
  }

  async function systemFolder() {
    if (systemFolderId) return systemFolderId;
    var q = "name = '" + quote(SYSTEM_FOLDER) + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var body = await (await call(API + '/files?pageSize=1&fields=files(id)&q=' + encodeURIComponent(q))).json();
    systemFolderId = body.files && body.files.length ? body.files[0].id : 'root';
    return systemFolderId;
  }

  /** Leaves a small note for a camera in Drive. Returns the new file's id. */
  async function leave(name, labels, content) {
    var boundary = 'vigil' + Math.random().toString(36).slice(2);
    var meta = { name: name, parents: [await systemFolder()], appProperties: labels };
    var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--' + boundary + '--';
    var response = await call(UPLOAD + '/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
    });
    if (!response.ok) throw new Error('The note could not be left');
    return (await response.json()).id;
  }

  // --------------------------------------------------------------------- sign-in

  function startSignIn() {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      text('v-signin-note', 'Google sign-in has not loaded. Check your connection, or any blocker on this page, and reload.');
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: function (reply) {
          if (!reply || reply.error || !reply.access_token) {
            text('v-signin-note', 'Sign-in did not finish. Please try again.');
            return;
          }
          if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(reply, SCOPE)) {
            text('v-signin-note', 'Vigil needs the Google Drive tick box on the sign-in screen. Please sign in again and leave it ticked.');
            return;
          }
          signedIn(reply.access_token, Number(reply.expires_in) || 3600);
        },
        error_callback: function () { text('v-signin-note', 'The sign-in window was closed or blocked. Please try again.'); }
      });
    }
    tokenClient.requestAccessToken({ prompt: '' });
  }

  function signedIn(value, seconds) {
    var renewing = !!token;
    token = value;
    clearTimeout(expiryTimer);
    show('v-renew', false);
    // Google's sign-in lasts an hour. Offer to renew a few minutes before it runs out.
    expiryTimer = setTimeout(function () { show('v-renew', true); }, Math.max(60, seconds - 240) * 1000);
    // A renewal just swaps the key over; whatever is on screen carries on untouched.
    if (renewing) return;
    text('v-signin-note', '');
    show('v-signin', false);
    if (openId) { show('v-camera', true); startLive(); } else { show('v-home', true); }
    if (!alertsSince) alertsSince = new Date().toISOString();
    loadAccount();
    refreshHome();
    clearInterval(homeTimer);
    homeTimer = setInterval(refreshHome, 30000);
    clearInterval(alertTimer);
    alertTimer = setInterval(checkAlerts, 15000);
  }

  function signedOut(message) {
    token = null;
    clearTimeout(expiryTimer);
    clearInterval(homeTimer);
    clearInterval(alertTimer);
    stopLive();
    show('v-renew', false);
    show('v-home', false);
    show('v-camera', false);
    show('v-signin', true);
    text('v-signin-note', message || '');
  }

  function signOut() {
    var old = token;
    if (old && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(old, function () {}); } catch (e) { /* nothing to undo */ }
    }
    openId = null;
    cameras = [];
    alertsSince = null;
    seenAlerts = {};
    alertLines = {};
    passphrases = {};
    keyCache = {};
    $('v-alerts').replaceChildren();
    signedOut('You are signed out.');
  }

  async function loadAccount() {
    try {
      var body = await (await call(API + '/about?fields=user(emailAddress)')).json();
      text('v-account', body.user && body.user.emailAddress ? body.user.emailAddress : '');
    } catch (e) { /* the address is only for show */ }
  }

  // ------------------------------------------------------------------------ home

  async function refreshHome() {
    if (!token) return;
    try {
      var files = await find({ vigil: 'camera' });
      var now = Date.now();
      var list = [];
      for (var i = 0; i < files.length; i++) {
        var beacon = await readJson(files[i].id);
        if (!beacon || !beacon.id) continue;
        var seen = Date.parse(files[i].modifiedTime) || 0;
        list.push({
          id: beacon.id, name: beacon.name || 'Camera', armed: beacon.armed !== false, paused: beacon.paused === true,
          watching: beacon.watching !== false, recording: beacon.recording === true,
          snapshotFileId: beacon.snapshotFileId || null, seenMs: seen,
          online: beacon.watching !== false && now - seen < ONLINE_MS,
          retentionDays: beacon.config && beacon.config.retentionDays ? beacon.config.retentionDays : 30,
          encSalt: beacon.config && beacon.config.encSalt ? beacon.config.encSalt : '',
          encCheck: beacon.config && beacon.config.encCheck ? beacon.config.encCheck : ''
        });
      }
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      cameras = list.slice(0, 4);
      text('v-home-note', cameras.length ? '' :
        'No cameras yet. Install Vigil on a spare phone, choose Camera, sign in with this Google account and press Start watching. It appears here within a minute.');
      drawGrid();
      if (openId) drawCameraStatus();
      for (var j = 0; j < cameras.length; j++) await refreshStill(cameras[j]);
    } catch (e) {
      if (!(e instanceof SignedOut)) text('v-home-note', 'Your cameras could not be loaded. Check your connection.');
    }
  }

  async function refreshStill(camera) {
    if (!camera.snapshotFileId) return;
    try {
      var blob = await readBlob(camera.snapshotFileId);
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      var old = stillUrls[camera.id];
      stillUrls[camera.id] = url;
      var tile = document.querySelector('[data-still="' + camera.id + '"]');
      if (tile) { tile.src = url; tile.hidden = false; }
      if (openId === camera.id && (!live || !live.linked)) { $('v-still').src = url; show('v-still', true); }
      if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 2000);
    } catch (e) { /* keep the last picture */ }
  }

  function statusOf(camera) {
    if (!camera.online) return ['Offline', 'off'];
    if (camera.recording) return ['Recording', 'rec'];
    if (camera.paused) return ['Paused', 'warn'];
    if (!camera.armed) return ['Disarmed', 'warn'];
    return ['Online', 'ok'];
  }

  function drawGrid() {
    var grid = $('v-grid');
    grid.replaceChildren();
    cameras.forEach(function (camera) {
      var card = el('button', 'vcard');
      card.type = 'button';
      var frame = el('span', 'vframe');
      var img = el('img');
      img.alt = '';
      img.setAttribute('data-still', camera.id);
      if (stillUrls[camera.id]) img.src = stillUrls[camera.id]; else img.hidden = true;
      frame.appendChild(img);
      var status = statusOf(camera);
      var pill = el('span', 'vpill ' + status[1], status[0]);
      frame.appendChild(pill);
      card.appendChild(frame);
      card.appendChild(el('span', 'vcard-name', camera.name));
      card.appendChild(el('span', 'vcard-detail', camera.online ? 'Open to watch live' : 'Last seen ' + ago(Date.now() - camera.seenMs)));
      card.addEventListener('click', function () { openCamera(camera.id); });
      grid.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------- camera

  function current() {
    for (var i = 0; i < cameras.length; i++) if (cameras[i].id === openId) return cameras[i];
    return null;
  }

  function openCamera(id) {
    openId = id;
    var camera = current();
    if (!camera) return;
    show('v-home', false);
    show('v-camera', true);
    text('v-name', camera.name);
    drawCameraStatus();
    $('v-still').hidden = !stillUrls[id];
    if (stillUrls[id]) $('v-still').src = stillUrls[id];
    var today = new Date();
    var oldest = new Date(today.getTime() - (camera.retentionDays - 1) * 86400000);
    $('v-day').max = dayKey(today);
    $('v-day').min = dayKey(oldest);
    $('v-day').value = dayKey(today);
    loadRecordings();
    startLive();
    window.scrollTo(0, 0);
  }

  function closeCamera() {
    stopLive();
    openId = null;
    show('v-camera', false);
    show('v-home', true);
    refreshHome();
  }

  function drawCameraStatus() {
    var camera = current();
    if (!camera) return;
    var status = live && live.linked ? ['Live', 'ok'] : statusOf(camera);
    var pill = $('v-status');
    pill.className = 'vpill ' + status[1];
    pill.textContent = status[0];
    $('v-arm').textContent = camera.armed ? 'Disarm' : 'Arm';
    $('v-arm').setAttribute('aria-pressed', camera.armed ? 'true' : 'false');
  }

  /** Sends an instruction to the open camera: over the live link if it is up, otherwise through Drive. */
  async function instruct(message, done) {
    var camera = current();
    if (!camera) return;
    var body = JSON.stringify(message);
    try {
      if (live && live.channel && live.channel.readyState === 'open') {
        live.channel.send(body);
        text('v-note', done);
      } else {
        text('v-note', 'Sending…');
        await leave('command-' + Date.now() + '.json', { vigil: 'command', to: camera.id }, body);
        text('v-note', done + '. The camera will act within a few seconds.');
      }
    } catch (e) {
      if (!(e instanceof SignedOut)) text('v-note', 'Could not reach the camera. Check your connection.');
    }
    setTimeout(function () { text('v-note', ''); }, 6000);
  }

  // ------------------------------------------------------------------- live view

  function stopLive() {
    if (!live) return;
    var old = live;
    live = null;
    old.stopped = true;
    clearInterval(old.pinger);
    try { if (old.channel) old.channel.close(); } catch (e) { /* already closed */ }
    try { if (old.peer) old.peer.close(); } catch (e) { /* already closed */ }
    var video = $('v-video');
    video.pause();
    video.srcObject = null;
    show('v-video', false);
    if (old.requestId && token) remove(old.requestId).catch(function () {});
  }

  function gathered(peer) {
    return new Promise(function (done) {
      if (peer.iceGatheringState === 'complete') { done(); return; }
      var timer = setTimeout(done, 4000);
      peer.addEventListener('icegatheringstatechange', function () {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
      });
    });
  }

  /** Tries to link straight to the camera. Resolves true once pictures can flow. */
  async function link(session, camera) {
    var peer = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] });
    session.peer = peer;
    var stream = new MediaStream();
    peer.addEventListener('track', function (event) {
      stream.addTrack(event.track);
      var video = $('v-video');
      if (video.srcObject !== stream) video.srcObject = stream;
    });
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });
    session.channel = peer.createDataChannel('control');

    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    if (session.stopped) return false;

    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var offer = { session: id, sdp: peer.localDescription.sdp, createdMs: Date.now(), wantsTalk: false };
    var offerFile = await leave('offer-' + id + '.json', { vigil: 'offer', to: camera.id, session: id }, JSON.stringify(offer));

    var answer = null;
    for (var tries = 0; tries < 20 && !answer && !session.stopped; tries++) {
      await wait(1000);
      var files = await find({ vigil: 'answer', session: id });
      if (!files.length) continue;
      var body = await readJson(files[0].id);
      remove(files[0].id).catch(function () {});
      if (body && body.sdp) answer = body.sdp;
    }
    if (!answer) {
      remove(offerFile).catch(function () {});
      return false;
    }
    if (session.stopped) return false;
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });

    for (var waited = 0; waited < 24 && !session.stopped; waited++) {
      var s = peer.iceConnectionState;
      if (s === 'connected' || s === 'completed') return true;
      if (s === 'failed' || s === 'closed') return false;
      await wait(500);
    }
    return false;
  }

  function dropped(peer) {
    return new Promise(function (done) {
      function check() {
        var s = peer.iceConnectionState;
        if (s === 'failed' || s === 'closed' || s === 'disconnected') done();
      }
      peer.addEventListener('iceconnectionstatechange', check);
      check();
    });
  }

  async function askForStills(session, camera) {
    var previous = session.requestId;
    session.requestId = await leave('stills-' + camera.id + '.json', { vigil: 'snapreq', to: camera.id }, '{}');
    if (previous) remove(previous).catch(function () {});
  }

  /** Keeps the open camera on screen: live video when a link can be made, fresh stills when not. */
  async function startLive() {
    stopLive();
    var camera = current();
    if (!camera || !token) return;
    var session = { stopped: false, linked: false, peer: null, channel: null, pinger: null, requestId: null };
    live = session;

    while (!session.stopped && token) {
      camera = current() || camera;
      var linked = false;
      if (camera.online && window.RTCPeerConnection) {
        text('v-stage-note', 'Linking to the camera. This can take up to 20 seconds.');
        try { linked = await link(session, camera); } catch (e) { linked = false; }
      }
      if (session.stopped) return;

      if (linked) {
        session.linked = true;
        text('v-stage-note', '');
        show('v-video', true);
        show('v-still', false);
        var video = $('v-video');
        try { await video.play(); } catch (e) {
          // Browsers may refuse sound until a button is pressed: start silent rather than not at all.
          video.muted = true;
          $('v-mute').textContent = 'Unmute';
          try { await video.play(); } catch (e2) { /* the picture appears once the page is clicked */ }
        }
        drawCameraStatus();
        session.pinger = setInterval(function () {
          try { if (session.channel.readyState === 'open') session.channel.send('{"type":"ping"}'); } catch (e) { /* link is closing */ }
        }, 5000);
        await dropped(session.peer);
        clearInterval(session.pinger);
        session.linked = false;
        if (session.stopped) return;
        show('v-video', false);
        drawCameraStatus();
      }
      try { if (session.peer) session.peer.close(); } catch (e) { /* already closed */ }
      session.peer = null;
      session.channel = null;

      // No live link: show stills for a minute, then try again.
      text('v-stage-note', camera.online ?
        'A direct link could not be made on this network, so you are seeing a fresh still every few seconds. Vigil keeps trying for live video.' :
        'This camera is not answering. Check that it is switched on, online and watching. This is the last picture it sent.');
      var until = Date.now() + (camera.online ? 60000 : 30000);
      var asked = 0;
      while (Date.now() < until && !session.stopped && token) {
        try {
          if (camera.online && Date.now() - asked > 20000) { asked = Date.now(); await askForStills(session, camera); }
          await refreshStill(camera);
        } catch (e) { if (e instanceof SignedOut) return; }
        await wait(camera.online ? 3000 : 15000);
      }
      if (!session.stopped) await refreshHome();
    }
  }

  // ------------------------------------------------------- encrypted recordings

  // Passphrases typed on this page, by camera. Kept in memory only; gone when the page closes.
  var passphrases = {};
  var keyCache = {};

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }
  function fromHex(text) {
    if (!text || text.length % 2) return null;
    var out = new Uint8Array(text.length / 2);
    for (var i = 0; i < out.length; i++) {
      var value = parseInt(text.substr(i * 2, 2), 16);
      if (isNaN(value)) return null;
      out[i] = value;
    }
    return out;
  }

  /** Turns a passphrase into the key's raw bytes (PBKDF2-HMAC-SHA256, 150,000 rounds), as the app does. */
  async function deriveBits(passphrase, salt) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, base, 256);
  }

  /** The short fingerprint a camera publishes so a passphrase can be checked without revealing the key. */
  async function keyCheck(bits) {
    var key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('vigil-key-check'));
    return toHex(new Uint8Array(mac).subarray(0, 8));
  }

  function NeedsPassphrase() { this.name = 'NeedsPassphrase'; }

  async function keyFor(cameraId, salt) {
    var passphrase = passphrases[cameraId];
    if (!passphrase) throw new NeedsPassphrase();
    var id = cameraId + ':' + toHex(salt);
    if (!keyCache[id]) {
      keyCache[id] = await crypto.subtle.importKey('raw', await deriveBits(passphrase, salt), 'AES-GCM', false, ['decrypt']);
    }
    return keyCache[id];
  }

  /**
   * Opens a recording sealed by the camera phone. Layout: "VIGILENC", version 1, 16-byte salt,
   * 8-byte nonce prefix, 4-byte piece size, then pieces each sealed with AES-256-GCM.
   * Returns the pieces of the plain file; throws if the passphrase is wrong or the file is damaged.
   */
  async function unseal(buffer, cameraId) {
    var bytes = new Uint8Array(buffer);
    var magic = 'VIGILENC';
    if (bytes.length < 37 + 16 || bytes[8] !== 1) throw new Error('damaged');
    for (var i = 0; i < 8; i++) if (bytes[i] !== magic.charCodeAt(i)) throw new Error('damaged');
    var salt = bytes.slice(9, 25);
    var prefix = bytes.subarray(25, 33);
    var piece = new DataView(buffer, 33, 4).getUint32(0);
    if (piece < 1 || piece > 16777216) throw new Error('damaged');
    var key = await keyFor(cameraId, salt);
    var parts = [];
    var offset = 37;
    var number = 0;
    for (;;) {
      var end = Math.min(offset + piece + 16, bytes.length);
      var last = end === bytes.length;
      var iv = new Uint8Array(12);
      iv.set(prefix, 0);
      new DataView(iv.buffer).setUint32(8, number);
      parts.push(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, additionalData: new Uint8Array([last ? 1 : 0]), tagLength: 128 },
        key, bytes.subarray(offset, end)
      ));
      if (last) break;
      offset = end;
      number++;
    }
    return parts;
  }

  function askPassphrase() {
    var camera = current();
    if (!camera) return;
    text('v-pass-note', '');
    $('v-pass-input').value = '';
    var dialog = $('v-pass');
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    $('v-pass-input').focus();
  }

  async function savePassphrase(event) {
    event.preventDefault();
    var camera = current();
    var typed = $('v-pass-input').value;
    if (!camera || !typed) return;
    text('v-pass-note', 'Checking…');
    try {
      var salt = fromHex(camera.encSalt);
      if (salt && salt.length === 16 && camera.encCheck) {
        var check = await keyCheck(await deriveBits(typed, salt));
        if (check !== camera.encCheck) { text('v-pass-note', "That is not this camera's passphrase."); return; }
      }
      passphrases[camera.id] = typed;
      Object.keys(keyCache).forEach(function (id) { if (id.indexOf(camera.id + ':') === 0) delete keyCache[id]; });
      var dialog = $('v-pass');
      if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
      loadRecordings();
    } catch (e) {
      text('v-pass-note', 'This browser could not check the passphrase.');
    }
  }

  // ------------------------------------------------------------------ recordings

  function assemble(files) {
    var thumbs = {};
    files.forEach(function (f) { if (f.appProperties.vigil === 'thumb' && f.appProperties.eventId) thumbs[f.appProperties.eventId] = f.id; });
    var clips = [];
    var seen = {};
    var film = null;
    files.forEach(function (f) {
      var p = f.appProperties;
      if (p.vigil === 'timelapse') {
        if (!film || Date.parse(f.modifiedTime) > Date.parse(film.modifiedTime)) film = f;
        return;
      }
      if (p.vigil !== 'clip' || !p.eventId || !p.startMs || seen[p.eventId]) return;
      seen[p.eventId] = true;
      var start = Number(p.startMs);
      var names = (p.types || '').split(',').filter(function (n) { return label(n); });
      clips.push({
        eventId: p.eventId, fileId: f.id, thumbId: thumbs[p.eventId] || null, startMs: start,
        endMs: Number(p.endMs) || start, names: names, starred: f.starred === true, bytes: Number(f.size) || 0,
        note: p.note || '', encrypted: p.enc === '1'
      });
    });
    clips.sort(function (a, b) { return b.startMs - a.startMs; });
    return { clips: clips, film: film };
  }

  async function loadRecordings() {
    var camera = current();
    var day = $('v-day').value;
    if (!camera || !day) return;
    var list = $('v-clips');
    list.replaceChildren();
    show('v-film', false);
    show('v-locked', false);
    text('v-rec-note', 'Loading…');
    try {
      var result = assemble(await find({ cameraId: camera.id, day: day }));
      if (openId !== camera.id || $('v-day').value !== day) return;
      var sealed = result.clips.some(function (c) { return c.encrypted; }) || (result.film && result.film.appProperties.enc === '1');
      show('v-locked', sealed);
      if (sealed) {
        text('v-locked-text', passphrases[camera.id] ?
          'These recordings are encrypted. This page has the passphrase until you close it.' :
          'These recordings were encrypted on the camera phone. Enter the passphrase to play them.');
        $('v-locked-btn').textContent = passphrases[camera.id] ? 'Change passphrase' : 'Enter passphrase';
      }
      if (result.film) {
        show('v-film', true);
        $('v-film').onclick = function () {
          play({
            fileId: result.film.id, title: 'Time-lapse  ·  ' + day, name: camera.name + ' time-lapse ' + day + '.mp4',
            bytes: Number(result.film.size) || 0, clip: null, encrypted: result.film.appProperties.enc === '1', cameraId: camera.id
          });
        };
      }
      text('v-rec-note', result.clips.length ? '' : (result.film ? 'No events were recorded on this day.' : 'Nothing was recorded on this day.'));
      result.clips.forEach(function (clip) { list.appendChild(clipRow(camera, clip)); });
    } catch (e) {
      if (!(e instanceof SignedOut)) text('v-rec-note', 'Recordings could not be loaded. Check your connection and try again.');
    }
  }

  function clipRow(camera, clip) {
    var head = headline(clip.names);
    var item = el('li');
    var button = el('button', 'vclip');
    button.type = 'button';
    var thumb = el('img', 'vclip-thumb');
    thumb.alt = '';
    thumb.loading = 'lazy';
    button.appendChild(thumb);
    var words = el('span', 'vclip-words');
    words.appendChild(el('span', 'vclip-title', head[1] + (clip.starred ? '  ★' : '')));
    words.appendChild(el('span', 'vclip-detail', clock(clip.startMs) + '  ·  ' + duration(clip.endMs - clip.startMs) + (clip.bytes ? '  ·  ' + size(clip.bytes) : '')));
    if (clip.note) words.appendChild(el('span', 'vclip-detail', clip.note));
    button.appendChild(words);
    button.addEventListener('click', function () {
      var stamp = new Date(clip.startMs);
      play({
        fileId: clip.fileId, title: head[1] + '  ·  ' + clock(clip.startMs),
        name: camera.name + ' ' + dayKey(stamp) + ' ' + pad(stamp.getHours()) + '.' + pad(stamp.getMinutes()) + ' ' + head[1] + '.mp4',
        bytes: clip.bytes, clip: clip, encrypted: clip.encrypted, cameraId: camera.id
      });
    });
    item.appendChild(button);
    if (clip.thumbId && (!clip.encrypted || passphrases[camera.id])) {
      readBlob(clip.thumbId).then(async function (blob) {
        if (!blob) return;
        if (clip.encrypted) blob = new Blob(await unseal(await blob.arrayBuffer(), camera.id), { type: 'image/jpeg' });
        thumb.src = URL.createObjectURL(blob);
      }).catch(function () {});
    }
    return item;
  }

  async function play(what) {
    var dialog = $('v-player');
    var video = $('v-player-video');
    closePlayer();
    text('v-player-title', what.title);
    text('v-player-note', 'Fetching from Drive…');
    show('v-player-video', false);
    show('v-player-actions', false);
    show('v-player-star', !!what.clip);
    show('v-player-delete', !!what.clip);
    if (what.clip) $('v-player-star').textContent = what.clip.starred ? 'Remove star' : 'Star to keep';
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    playing = { what: what, url: null, cancelled: false };
    var mine = playing;
    try {
      if (what.encrypted && !passphrases[what.cameraId]) throw new NeedsPassphrase();
      var response = await call(API + '/files/' + what.fileId + '?alt=media');
      if (!response.ok) throw new Error('gone');
      var total = what.bytes || Number(response.headers.get('Content-Length')) || 0;
      var parts = [];
      var done = 0;
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader();
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          if (mine.cancelled) { reader.cancel(); return; }
          parts.push(chunk.value);
          done += chunk.value.length;
          if (total) text('v-player-note', 'Fetching from Drive  ·  ' + Math.min(100, Math.round(done * 100 / total)) + '%');
        }
      } else {
        parts.push(await response.arrayBuffer());
      }
      if (mine.cancelled) return;
      if (what.encrypted) {
        text('v-player-note', 'Opening…');
        parts = await unseal(await new Blob(parts).arrayBuffer(), what.cameraId);
        if (mine.cancelled) return;
      }
      mine.url = URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
      video.src = mine.url;
      $('v-player-save').href = mine.url;
      $('v-player-save').download = what.name.replace(/[^A-Za-z0-9 ._-]/g, '_');
      text('v-player-note', '');
      show('v-player-video', true);
      show('v-player-actions', true);
      video.play().catch(function () {});
    } catch (e) {
      if (e instanceof SignedOut) return;
      if (e instanceof NeedsPassphrase) text('v-player-note', 'This recording is encrypted. Close this and enter the passphrase first.');
      else if (what.encrypted && e && e.name === 'OperationError') text('v-player-note', 'The passphrase does not open this recording. Close this and enter it again.');
      else text('v-player-note', 'This recording could not be fetched. It may have been deleted, or the connection dropped.');
    }
  }

  function closePlayer() {
    var video = $('v-player-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (playing) {
      playing.cancelled = true;
      if (playing.url) URL.revokeObjectURL(playing.url);
      playing = null;
    }
    var dialog = $('v-player');
    if (dialog.open) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
  }

  async function starPlaying() {
    if (!playing || !playing.what.clip) return;
    var clip = playing.what.clip;
    var next = !clip.starred;
    try {
      var ids = [clip.fileId].concat(clip.thumbId ? [clip.thumbId] : []);
      for (var i = 0; i < ids.length; i++) {
        await call(API + '/files/' + ids[i] + '?fields=id', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: next })
        });
      }
      clip.starred = next;
      $('v-player-star').textContent = next ? 'Remove star' : 'Star to keep';
      text('v-player-note', next ? 'Starred. It will not be cleared automatically.' : 'Star removed.');
      loadRecordings();
    } catch (e) {
      if (!(e instanceof SignedOut)) text('v-player-note', 'The star could not be changed. Check your connection.');
    }
  }

  async function deletePlaying() {
    if (!playing || !playing.what.clip) return;
    var clip = playing.what.clip;
    if (!window.confirm('Delete this recording from your Google Drive? Drive keeps it in its bin for 30 days.')) return;
    try {
      await remove(clip.fileId);
      if (clip.thumbId) await remove(clip.thumbId).catch(function () {});
      closePlayer();
      loadRecordings();
    } catch (e) {
      if (!(e instanceof SignedOut)) text('v-player-note', 'The recording could not be deleted. Check your connection.');
    }
  }

  // ---------------------------------------------------------------------- alerts

  async function checkAlerts() {
    if (!token || !alertsSince) return;
    try {
      var files = await find({ vigil: 'alert' }, "modifiedTime > '" + alertsSince + "'");
      files.sort(function (a, b) { return Date.parse(a.modifiedTime) - Date.parse(b.modifiedTime); });
      for (var i = 0; i < files.length; i++) {
        var alert = await readJson(files[i].id);
        if (Date.parse(files[i].modifiedTime) > Date.parse(alertsSince)) alertsSince = files[i].modifiedTime;
        if (!alert || !alert.id) continue;
        var names = (alert.types || []).filter(function (n) { return label(n); });
        var head = headline(names)[1];
        var key = alert.id + ':' + names.join(',') + ':' + (alert.note || '');
        if (seenAlerts[key]) continue;
        var fresh = !seenAlerts[alert.id];
        seenAlerts[key] = true;
        seenAlerts[alert.id] = true;
        showAlert(alert, head, fresh);
      }
    } catch (e) { /* try again on the next round */ }
  }

  function showAlert(alert, head, fresh) {
    var list = $('v-alerts');
    // The same event told again (it grew more important, or a description arrived) updates its line.
    var line = alertLines[alert.id];
    if (line) line.replaceChildren(); else { line = el('li'); alertLines[alert.id] = line; list.insertBefore(line, list.firstChild); }
    line.className = alert.critical ? 'critical' : '';
    line.appendChild(el('strong', null, (alert.cameraName || 'Camera') + ': ' + head));
    line.appendChild(el('span', null, '  ·  ' + clock(alert.atMs || Date.now()) + (alert.note ? '  ·  ' + alert.note : '')));
    while (list.children.length > 30) list.removeChild(list.lastChild);
    show('v-alerts-empty', false);
    if (fresh && $('v-notify').checked && window.Notification && Notification.permission === 'granted') {
      try { new Notification((alert.cameraName || 'Camera') + ': ' + head, { body: 'Vigil  ·  ' + clock(alert.atMs || Date.now()), tag: 'vigil-' + alert.cameraId }); } catch (e) { /* not allowed here */ }
    }
  }

  function toggleNotify() {
    var box = $('v-notify');
    if (!box.checked) return;
    if (!window.Notification) {
      box.checked = false;
      text('v-notify-note', 'This browser cannot show notifications.');
      return;
    }
    if (Notification.permission === 'granted') return;
    Notification.requestPermission().then(function (answer) {
      if (answer !== 'granted') {
        box.checked = false;
        text('v-notify-note', 'Notifications are blocked for this page in your browser settings.');
      }
    });
  }

  // ----------------------------------------------------------------------- start

  function start() {
    $('v-signin-btn').addEventListener('click', startSignIn);
    $('v-renew-btn').addEventListener('click', startSignIn);
    $('v-signout').addEventListener('click', signOut);
    $('v-back').addEventListener('click', closeCamera);
    $('v-arm').addEventListener('click', function () {
      var camera = current();
      if (!camera) return;
      var next = !camera.armed;
      camera.armed = next;
      drawCameraStatus();
      instruct({ type: 'arm', on: next }, next ? 'Armed' : 'Disarmed');
    });
    $('v-siren').addEventListener('click', function () {
      var on = $('v-siren').getAttribute('aria-pressed') !== 'true';
      if (on && !window.confirm('Sound the siren? The camera phone plays a loud alarm for 30 seconds, or until you stop it.')) return;
      $('v-siren').setAttribute('aria-pressed', on ? 'true' : 'false');
      $('v-siren').textContent = on ? 'Stop siren' : 'Siren';
      instruct({ type: 'siren', on: on }, on ? 'Siren on' : 'Siren off');
      if (on) setTimeout(function () { $('v-siren').setAttribute('aria-pressed', 'false'); $('v-siren').textContent = 'Siren'; }, 30000);
    });
    $('v-flash').addEventListener('click', function () { instruct({ type: 'flash' }, 'Torch flashing'); });
    $('v-mute').addEventListener('click', function () {
      var video = $('v-video');
      video.muted = !video.muted;
      $('v-mute').textContent = video.muted ? 'Unmute' : 'Mute';
    });
    $('v-say-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var words = $('v-say').value.trim();
      if (!words) return;
      instruct({ type: 'say', text: words.slice(0, 200) }, 'Sent to the camera to say out loud');
      $('v-say').value = '';
    });
    $('v-day').addEventListener('change', loadRecordings);
    $('v-refresh').addEventListener('click', loadRecordings);
    $('v-player-close').addEventListener('click', closePlayer);
    $('v-player').addEventListener('close', closePlayer);
    $('v-player-star').addEventListener('click', starPlaying);
    $('v-player-delete').addEventListener('click', deletePlaying);
    $('v-notify').addEventListener('change', toggleNotify);
    $('v-locked-btn').addEventListener('click', askPassphrase);
    $('v-pass-form').addEventListener('submit', savePassphrase);
    $('v-pass-cancel').addEventListener('click', function () {
      var dialog = $('v-pass');
      if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    });
    window.addEventListener('pagehide', stopLive);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
