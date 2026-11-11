/* Wecord — página do celular: envia câmera + microfone para o Wecord do PC */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const PREFIX = 'wecord-v1-cam-';

  const ICONS = {
    cam: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    camOff: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><path d="M2 2l20 20"/>',
    flip: '<path d="M20 7h-3l-2-3H9L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M9 13a3 3 0 0 1 5.2-2M15 13a3 3 0 0 1-5.2 2"/><path d="M14 9v2h-2M10 17v-2h2"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  };
  const setIcon = (el, name) => { el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`; };

  /* ---------- parâmetros do link (QR code) ---------- */
  const params = new URLSearchParams(location.hash.slice(1));
  const code = (params.get('c') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (params.get('tu')) iceServers.push({ urls: params.get('tu').split(','), username: params.get('tn') || '', credential: params.get('tp') || '' });
  const peerOpts = { debug: 1, config: { iceServers } };
  if (params.get('sh')) {
    peerOpts.host = params.get('sh');
    peerOpts.port = Number(params.get('sp')) || 443;
    peerOpts.path = params.get('sa') || '/';
    peerOpts.secure = peerOpts.port !== 80;
  }

  /* ---------- estado ---------- */
  let audio = null;          // faixa do microfone
  let video = null;          // faixa da câmera (null quando desligada)
  let canVideo = false;      // o celular tem câmera e deu permissão
  let facing = 'user';
  let pcWantsVideo = true;   // o PC pediu a câmera
  let peer = null, conn = null, call = null;
  let pcName = '';
  let retryTimer = null;
  let wakeLock = null;
  let black = false;
  let camBeforeBlack = true;
  let placeholder = null;    // faixa preta usada só para abrir o canal de vídeo com a câmera desligada

  /* ---------- interface ---------- */
  function status(text, kind = '') {
    $('#status-text').textContent = text;
    $('#status').className = 'pill ' + kind;
  }
  function show(step) {
    for (const id of ['step-start', 'step-live', 'step-error']) $('#' + id).hidden = id !== step;
  }
  function fail(title, text) {
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
    show('step-error');
    status('Desconectado', 'err');
  }
  function renderLive() {
    const on = !!(video && video.readyState === 'live');
    const v = $('#preview');
    v.classList.toggle('mirror', facing === 'user');
    $('#preview-off').hidden = on;
    $('#preview-off-text').textContent = !canVideo ? 'Sem câmera — só o microfone está sendo enviado'
      : !pcWantsVideo ? 'Câmera desligada no PC' : 'Câmera desligada';
    setIcon($('#ico-cam'), on ? 'cam' : 'camOff');
    $('#btn-cam').classList.toggle('off', !on);
    $('#btn-cam').disabled = !canVideo;
    $('#btn-flip').disabled = !canVideo || !on;
  }
  setIcon($('#ico-flip'), 'flip');
  setIcon($('#ico-black'), 'moon');

  /* ---------- mídia ---------- */
  const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const videoConstraints = () => ({ facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });

  async function getVideo() {
    const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
    const t = s.getVideoTracks()[0];
    t.contentHint = 'motion';
    return t;
  }
  async function getAudio() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    return s.getAudioTracks()[0];
  }

  function setPreview() {
    $('#preview').srcObject = video ? new MediaStream([video]) : null;
    renderLive();
  }

  function transceiver(kind) {
    const pc = call && call.peerConnection;
    if (!pc) return null;
    return pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === kind) || null;
  }

  async function sendTrack(kind, track) {
    const tr = transceiver(kind);
    if (tr) { try { await tr.sender.replaceTrack(track); } catch (e) { console.warn('replaceTrack', e); } }
  }

  async function setCamera(on) {
    if (!canVideo) return;
    if (on && (!video || video.readyState !== 'live')) {
      try {
        video = await getVideo();
      } catch (e) {
        console.warn('camera', e);
        video = null;
      }
      await sendTrack('video', video);
    } else if (!on && video) {
      const old = video;
      video = null;
      await sendTrack('video', null);
      old.stop();
    }
    setPreview();
  }

  async function flip() {
    if (!video) return;
    facing = facing === 'user' ? 'environment' : 'user';
    const old = video;
    old.stop(); // o iOS só permite uma câmera aberta por vez
    try {
      video = await getVideo();
    } catch {
      facing = facing === 'user' ? 'environment' : 'user';
      video = await getVideo().catch(() => null);
    }
    await sendTrack('video', video);
    setPreview();
    send({ t: 'hello', video: canVideo, audio: !!audio, facing });
  }

  function blackTrack() {
    if (placeholder && placeholder.readyState === 'live') return placeholder;
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    c.getContext('2d').fillRect(0, 0, 16, 16);
    placeholder = c.captureStream(1).getVideoTracks()[0];
    return placeholder;
  }

  /* ---------- indicador de voz ---------- */
  let actx = null;
  function startMeter() {
    if (!audio) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaStreamSource(new MediaStream([audio]));
      const an = actx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const bar = $('#meter-bar');
      const dot = document.querySelector('.black-info .dot');
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += (v - 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) / 40);
        bar.style.width = (level * 100).toFixed(0) + '%';
        dot.classList.toggle('speaking', level > 0.15);
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.warn('meter', e); }
  }

  /* ---------- tela sempre ligada ---------- */
  async function keepAwake() {
    if (!('wakeLock' in navigator)) { $('#wake-hint').hidden = false; return; }
    try {
      if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen');
    } catch { $('#wake-hint').hidden = false; }
  }

  /* ---------- conexão com o PC ---------- */
  function send(m) { if (conn && conn.open) { try { conn.send(m); } catch { /* ignore */ } } }

  function scheduleRetry(ms = 3000) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  }

  function teardownCall() {
    try { call && call.close(); } catch { /* ignore */ }
    try { conn && conn.close(); } catch { /* ignore */ }
    call = null; conn = null;
  }

  function lost() {
    teardownCall();
    status('Procurando o PC…');
    scheduleRetry(2500);
  }

  function connect() {
    clearTimeout(retryTimer);
    teardownCall();
    if (!peer || peer.destroyed) {
      peer = new window.Peer(peerOpts);
      peer.on('open', () => connect());
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 1500); });
      peer.on('error', (err) => {
        console.warn('peer', err.type, err.message);
        if (err.type === 'peer-unavailable') {
          status('Abra o Wecord no PC…');
          scheduleRetry(3000);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          status('Sem internet — tentando…', 'err');
          try { peer.destroy(); } catch { /* ignore */ }
          peer = null;
          scheduleRetry(4000);
        }
      });
      status('Conectando…');
      return;
    }
    if (!peer.open) return; // 'open' chama connect() de novo
    status('Procurando o PC…');
    const target = PREFIX + code;
    const c = (conn = peer.connect(target, { reliable: true }));
    c.on('open', () => {
      if (conn !== c) return;
      send({ t: 'hello', video: canVideo, audio: !!audio, facing });
      const tracks = [];
      if (audio) tracks.push(audio);
      if (canVideo) tracks.push(video && video.readyState === 'live' ? video : blackTrack());
      const k = (call = peer.call(target, new MediaStream(tracks), { metadata: { kind: 'wecord-phone' } }));
      const pc = k.peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          if (call !== k) return;
          if (pc.connectionState === 'connected') {
            status(pcName ? 'Conectado a ' + pcName : 'Conectado ao PC', 'ok');
            tuneSender();
            if (canVideo && (!video || video.readyState !== 'live')) sendTrack('video', null);
          } else if (pc.connectionState === 'failed') lost();
        });
      }
      k.on('close', () => { if (call === k) lost(); });
      k.on('error', () => { if (call === k) lost(); });
    });
    c.on('data', onMessage);
    c.on('close', () => { if (conn === c) lost(); });
    c.on('error', () => { if (conn === c) lost(); });
  }

  async function tuneSender() {
    const tr = transceiver('video');
    if (!tr) return;
    try {
      const p = tr.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 2500000;
      p.encodings[0].maxFramerate = 30;
      await tr.sender.setParameters(p);
    } catch (e) { console.warn('setParameters', e); }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      pcName = String(m.name || '').slice(0, 40);
      if (call && call.peerConnection && call.peerConnection.connectionState === 'connected') status(pcName ? 'Conectado a ' + pcName : 'Conectado ao PC', 'ok');
    } else if (m.t === 'need') {
      pcWantsVideo = !!m.video;
      if (!black) setCamera(pcWantsVideo);
      else renderLive();
    }
  }

  /* ---------- início ---------- */
  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('Navegador sem suporte', 'Abra este link no Safari (iPhone) ou no Chrome (Android).');
      return;
    }
    $('#btn-start').disabled = true;
    actx = new (window.AudioContext || window.webkitAudioContext)(); // precisa nascer de um toque no iOS
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints() });
      audio = s.getAudioTracks()[0] || null;
      video = s.getVideoTracks()[0] || null;
      if (video) video.contentHint = 'motion';
      canVideo = !!video;
    } catch (e) {
      console.warn('getUserMedia', e);
      try { audio = await getAudio(); } catch { /* ignore */ }
      if (!audio) {
        $('#btn-start').disabled = false;
        fail('Sem permissão', 'Não consegui acessar a câmera nem o microfone. No iPhone: Ajustes → Safari → Câmera e Microfone → Permitir. Depois toque em "Tentar de novo".');
        return;
      }
    }
    show('step-live');
    setPreview();
    startMeter();
    keepAwake();
    connect();
  }

  /* volta do segundo plano: o iOS pode ter encerrado a câmera/microfone */
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !audio) return;
    keepAwake();
    if (actx && actx.state !== 'running') actx.resume().catch(() => {});
    if (audio.readyState === 'ended') {
      try { audio = await getAudio(); await sendTrack('audio', audio); startMeter(); } catch { /* ignore */ }
    }
    if (video && video.readyState === 'ended') { video = null; if (pcWantsVideo && !black) await setCamera(true); }
    setPreview();
    if (!call) connect();
  });

  $('#btn-start').addEventListener('click', start);
  $('#btn-retry').addEventListener('click', () => { show('step-start'); $('#btn-start').disabled = false; });
  $('#btn-cam').addEventListener('click', () => {
    const on = !(video && video.readyState === 'live');
    if (conn && conn.open) send({ t: 'cam', on }); // o PC decide e responde com "need"
    else { pcWantsVideo = on; setCamera(on); }
  });
  $('#btn-flip').addEventListener('click', flip);

  /* tela preta: desliga a câmera e escurece tudo, o microfone continua */
  $('#btn-black').addEventListener('click', () => {
    black = true;
    camBeforeBlack = !!(video && video.readyState === 'live');
    if (camBeforeBlack) { send({ t: 'cam', on: false }); setCamera(false); }
    $('#black').hidden = false;
  });
  let lastTap = 0;
  $('#black').addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 400) {
      black = false;
      $('#black').hidden = true;
      if (camBeforeBlack) { send({ t: 'cam', on: true }); if (!conn || !conn.open) setCamera(true); }
    }
    lastTap = now;
  });

  if (!code) {
    fail('Link incompleto', 'Abra o Wecord no PC, vá em Ajustes → "Usar celular como câmera" e escaneie o QR code com a câmera do iPhone.');
    $('#btn-retry').hidden = true;
  } else {
    show('step-start');
    status('Pronto para começar');
  }
})();
