/* Wecord — interface */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const native = window.wecordNative || null;
  const { Room, QUALITY, normalizeCode, formatCode } = window.Wecord;
  const { PhoneLink, newCode, qrSvg } = window.WecordPhone;
  const canShareSystemAudio = !native || native.platform === 'win32';

  // Modo celular: site aberto num telefone/tablet (tela de toque pequena)
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = !native && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
  const canShareScreen = !isMobile && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isMobile) document.documentElement.classList.add('mobile');
  if (isIOS) document.documentElement.classList.add('ios');
  if (isStandalone) document.documentElement.classList.add('standalone');

  /* ================================================================ */
  /* Configurações                                                     */
  /* ================================================================ */
  const DEFAULTS = {
    name: '', micId: '', camId: '', outId: '',
    noise: true, sounds: true, startMic: true, startCam: true,
    quality: '1080p30', hint: 'motion', shareAudio: true,
    turnUrl: '', turnUser: '', turnPass: '',
    serverHost: '', serverPort: '443', serverPath: '/',
    phoneCode: '', facing: 'user',
  };
  const settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('wecord.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem('wecord.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

  function iceServers() {
    const list = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];
    if (settings.turnUrl.trim()) {
      list.push({ urls: settings.turnUrl.split(',').map((s) => s.trim()).filter(Boolean), username: settings.turnUser, credential: settings.turnPass });
    }
    return list;
  }
  function signalServer() {
    if (!settings.serverHost.trim()) return null;
    return { host: settings.serverHost.trim(), port: settings.serverPort || 443, path: settings.serverPath || '/', secure: String(settings.serverPort) !== '80' };
  }

  /* ================================================================ */
  /* Utilidades                                                        */
  /* ================================================================ */
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      if (settings.outId && audioCtx.setSinkId) audioCtx.setSinkId(settings.outId).catch(() => {});
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  const Sound = {
    tone(freqs, dur = 0.13, gap = 0.1, vol = 0.07) {
      if (!settings.sounds || deafened) return;
      try {
        const a = ctx();
        let t = a.currentTime + 0.02;
        for (const f of freqs) {
          const o = a.createOscillator();
          const g = a.createGain();
          o.type = 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(vol, t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g).connect(a.destination);
          o.start(t);
          o.stop(t + dur + 0.05);
          t += gap;
        }
      } catch { /* ignore */ }
    },
    join() { this.tone([523.25, 783.99]); },
    leave() { this.tone([659.25, 392]); },
    msg() { this.tone([987.77], 0.09, 0, 0.05); },
    on() { this.tone([700], 0.07, 0, 0.045); },
    off() { this.tone([420], 0.07, 0, 0.045); },
  };

  function toast(text, type = '', ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  const COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#eab308', '#ef4444'];
  function colorFor(s) {
    let h = 0;
    for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();
  const myName = () => settings.name.trim() || 'Convidado';

  function friendlyError(e) {
    if (!e) return 'Erro desconhecido.';
    if (e.friendly) return e.message;
    const t = e.type || e.name;
    if (t === 'browser-incompatible') return 'Seu navegador não suporta chamadas. Use o app Wecord.';
    if (t === 'unavailable-id') return 'Esse código já está em uso. Tente criar outra sala.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Não consegui conectar ao servidor. Verifique sua internet.';
    if (t === 'NotAllowedError') return 'Permissão negada para câmera/microfone.';
    if (t === 'NotFoundError') return 'Dispositivo não encontrado.';
    if (t === 'NotReadableError') return 'O dispositivo está sendo usado por outro programa.';
    return e.message || String(e);
  }

  /* ================================================================ */
  /* Mídia local                                                       */
  /* ================================================================ */
  const local = {
    main: new MediaStream(), // microfone + câmera
    mic: null,
    cam: null,
    screen: null,
    micOn: settings.startMic,
    camOn: settings.startCam,
  };
  let deafened = false;
  let room = null;

  const micConstraints = () => ({
    deviceId: settings.micId && settings.micId !== 'phone' ? { exact: settings.micId } : undefined,
    echoCancellation: true,
    noiseSuppression: !!settings.noise,
    autoGainControl: true,
    channelCount: 1,
  });
  const camConstraints = () => ({
    deviceId: settings.camId && settings.camId !== 'phone' ? { exact: settings.camId } : undefined,
    facingMode: isMobile && !settings.camId ? settings.facing : undefined,
    width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
  });

  async function getTrack(kind) {
    if ((kind === 'audio' ? settings.micId : settings.camId) === 'phone') {
      const src = phone && (kind === 'audio' ? phone.audioTrack : phone.videoTrack);
      if (src) {
        const t = src.clone();
        phoneSource.set(t, src);
        return t;
      }
      // celular não conectado: cai para o dispositivo padrão do PC
    }
    const c = kind === 'audio' ? micConstraints() : camConstraints();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ [kind]: c });
      return s.getTracks()[0];
    } catch (e) {
      // dispositivo salvo pode ter sido desconectado — tenta o padrão
      if ((e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && c.deviceId) {
        delete c.deviceId;
        const s = await navigator.mediaDevices.getUserMedia({ [kind]: c });
        return s.getTracks()[0];
      }
      throw e;
    }
  }

  async function ensureMic() {
    if (local.mic && local.mic.readyState === 'live') return true;
    try {
      const t = await getTrack('audio');
      t.contentHint = 'speech';
      t.enabled = local.micOn && !deafened;
      t.addEventListener('ended', () => { if (local.mic === t) { local.main.removeTrack(t); room && room.removeTrack(t); local.mic = null; render(); } });
      local.main.addTrack(t);
      local.mic = t;
      if (room) room.addTrack(t, local.main, 'main');
      refreshDevices();
      return true;
    } catch (e) {
      console.warn('mic', e);
      if (settings.micId !== 'phone') toast('Microfone: ' + friendlyError(e), 'error', 4500); // celular ainda vai conectar
      local.micOn = false;
      return false;
    }
  }

  async function startCam() {
    if (local.cam) return true;
    try {
      const t = await getTrack('video');
      t.contentHint = 'motion';
      t.addEventListener('ended', () => { if (local.cam === t) stopCam(); });
      local.main.addTrack(t);
      local.cam = t;
      local.camOn = true;
      if (room) room.addTrack(t, local.main, 'main');
      refreshDevices();
      return true;
    } catch (e) {
      console.warn('cam', e);
      if (settings.camId !== 'phone') toast('Câmera: ' + friendlyError(e), 'error', 4500);
      local.camOn = false;
      return false;
    }
  }

  function stopCam() {
    const t = local.cam;
    local.cam = null;
    local.camOn = false;
    if (!t) return;
    t.stop();
    local.main.removeTrack(t);
    if (room) room.removeTrack(t);
  }

  async function swapDevice(kind) {
    const old = kind === 'audio' ? local.mic : local.cam;
    if (!old) {
      // ainda não havia dispositivo (ex: PC sem câmera): liga com o novo
      if (kind === 'audio') { local.micOn = true; await ensureMic(); room && room.setState({ mic: local.micOn && !deafened }); }
      else { await startCam(); room && room.setState({ cam: !!local.cam }); }
      render();
      return;
    }
    try {
      const t = await getTrack(kind);
      if (kind === 'audio') { t.contentHint = 'speech'; t.enabled = local.micOn && !deafened; local.mic = t; } else { t.contentHint = 'motion'; local.cam = t; }
      local.main.removeTrack(old);
      local.main.addTrack(t);
      if (room) room.replaceTrack(old, t);
      old.stop();
      render();
    } catch (e) {
      toast('Não consegui trocar o dispositivo: ' + friendlyError(e), 'error');
    }
  }

  /* troca câmera frontal/traseira (celular). O iOS só deixa uma câmera aberta por vez. */
  async function flipCam() {
    settings.facing = settings.facing === 'environment' ? 'user' : 'environment';
    settings.camId = '';
    saveSettings();
    const old = local.cam;
    if (!old) { render(); return; }
    local.cam = null; // evita que o 'ended' da faixa antiga desligue a câmera
    old.stop();
    try {
      const t = await getTrack('video');
      t.contentHint = 'motion';
      t.addEventListener('ended', () => { if (local.cam === t) stopCam(); });
      local.main.removeTrack(old);
      local.main.addTrack(t);
      local.cam = t;
      if (room) room.replaceTrack(old, t);
    } catch (e) {
      local.main.removeTrack(old);
      if (room) { room.removeTrack(old); room.setState({ cam: false }); }
      local.camOn = false;
      toast('Câmera: ' + friendlyError(e), 'error');
    }
    render();
  }
  const mirrorMe = () => !(isMobile && settings.facing === 'environment');

  async function toggleMic() {
    if (deafened) { setDeaf(false); if (local.micOn) return; }
    if (!local.mic) {
      local.micOn = true;
      if (!(await ensureMic())) { render(); return; }
    } else {
      local.micOn = !local.micOn;
    }
    if (local.mic) local.mic.enabled = local.micOn;
    local.micOn ? Sound.on() : Sound.off();
    if (!room) { settings.startMic = local.micOn; saveSettings(); }
    room && room.setState({ mic: local.micOn });
    render();
  }

  async function toggleCam() { await setCam(!local.cam); }

  async function setCam(on) {
    if (on && !local.cam) await startCam();
    else if (!on && local.cam) stopCam();
    if (phone && phone.connected) phoneCamWanted = !!local.cam && isPhoneTrack(local.cam);
    if (!room) { settings.startCam = local.camOn; saveSettings(); }
    room && room.setState({ cam: !!local.cam });
    render();
  }

  /* ---------- celular como câmera/microfone ---------- */
  let phone = null;
  const phoneSource = new WeakMap(); // faixa clonada -> faixa remota do celular
  const isPhoneTrack = (t) => !!t && phoneSource.has(t);
  let phoneCamWanted = settings.startCam; // ligar a câmera do celular quando ele (re)conectar
  let phoneFirst = true;      // primeira conexão nesta sessão
  let phoneHello = '';

  function ensurePhoneLink() {
    if (phone) return phone;
    if (!settings.phoneCode) { settings.phoneCode = newCode(); saveSettings(); }
    phone = new PhoneLink({ code: settings.phoneCode, iceServers: iceServers(), server: signalServer(), isNative: !!native });
    phone.addEventListener('status', renderPhone);
    phone.addEventListener('tracks', onPhoneTracks);
    phone.addEventListener('lost', onPhoneLost);
    phone.addEventListener('cam', async (e) => {
      const on = e.detail;
      if (on && phone.videoTrack && settings.camId !== 'phone') {
        settings.camId = 'phone';
        saveSettings();
        if (local.cam) { await swapDevice('video'); phoneCamWanted = true; render(); return; }
      }
      await setCam(on);
    });
    phone.start();
    phoneHello = '';
    return phone;
  }

  let phoneBusy = Promise.resolve();
  function onPhoneTracks() {
    // serializa: 'tracks' pode chegar duas vezes seguidas (stream + capacidades)
    phoneBusy = phoneBusy.then(applyPhoneTracks).catch((e) => console.warn('phone tracks', e));
  }
  async function applyPhoneTracks() {
    if (!phone || !phone.connected) return;
    let changed = false;
    const a = phone.audioTrack;
    if (a && !(local.mic && phoneSource.get(local.mic) === a)) {
      settings.micId = 'phone';
      if (phoneFirst) local.micOn = true;
      if (local.mic) await swapDevice('audio');
      else await ensureMic();
      room && room.setState({ mic: local.micOn && !deafened });
      changed = true;
    }
    const v = phone.videoTrack;
    if (v && phoneCamWanted && !(local.cam && phoneSource.get(local.cam) === v)) {
      settings.camId = 'phone';
      if (local.cam) await swapDevice('video');
      else await startCam();
      room && room.setState({ cam: !!local.cam });
      changed = true;
    }
    if (changed) {
      saveSettings();
      if (phoneFirst) toast('Celular conectado! Ele agora é sua ' + (v ? 'câmera e ' : '') + 'microfone.', 'ok', 4500);
      else toast('Celular reconectado', 'ok');
      phoneFirst = false;
      refreshDevices();
    }
    render();
  }

  function onPhoneLost() {
    let changed = false;
    if (isPhoneTrack(local.mic)) {
      const t = local.mic;
      local.mic = null;
      local.main.removeTrack(t);
      room && room.removeTrack(t);
      t.stop();
      changed = true;
    }
    if (isPhoneTrack(local.cam)) {
      phoneCamWanted = true;
      stopCam();
      room && room.setState({ cam: false });
      changed = true;
    }
    if (changed) toast('O celular desconectou. Volte ao Safari nele que reconecta sozinho.', 'error', 6000);
    render();
  }

  function stopPhone() {
    if (!phone) return;
    const p = phone;
    phone = null;
    p.stop();
    onPhoneLost();
    if (settings.micId === 'phone') settings.micId = '';
    if (settings.camId === 'phone') settings.camId = '';
    saveSettings();
    phoneFirst = true;
    phoneCamWanted = true;
    // volta para o microfone/câmera do PC, se houver
    if (local.micOn) ensureMic();
    refreshDevices();
    render();
  }

  function openPhone() {
    ensurePhoneLink();
    const box = $('#phone-qr');
    box.replaceChildren(qrSvg(phone.url, 196));
    $('#phone-url').value = phone.url;
    renderPhone();
    if (!$('#phone-dialog').open) $('#phone-dialog').showModal();
  }

  function renderPhone() {
    const on = !!(phone && phone.connected);
    const st = $('#phone-status');
    st.classList.toggle('ok', on);
    $('#phone-status-text').textContent = on
      ? 'Celular conectado' + (phone.caps.video ? ' — câmera e microfone' : ' — microfone')
      : 'Aguardando o celular…';
    $('#phone-stop').hidden = !phone;
    $('#pre-phone').classList.toggle('on', on);
    $('#pre-phone-text').textContent = on ? 'Celular conectado' : phone ? 'Conectar o celular' : 'Sem câmera ou microfone? Use o celular';
    $('#set-phone').classList.toggle('on', on);
    $('#set-phone-text').textContent = on ? 'Celular conectado — ver detalhes' : 'Usar o celular como câmera e microfone';
  }

  function syncPhone() {
    if (!phone) return;
    phone.setNeed(isPhoneTrack(local.cam));
    const hello = myName() + '|' + !!room;
    if (hello !== phoneHello) { phoneHello = hello; phone.setHello({ name: myName(), inCall: !!room }); }
  }

  function setDeaf(v) {
    deafened = v;
    if (local.mic) local.mic.enabled = local.micOn && !deafened;
    for (const p of people.values()) applyAudio(p);
    room && room.setState({ deaf: deafened, mic: local.micOn && !deafened });
    render();
  }

  /* ---------- compartilhamento de tela ---------- */
  async function startShare(sourceId) {
    const q = QUALITY[settings.quality] || QUALITY['1080p30'];
    const wantAudio = settings.shareAudio && canShareSystemAudio;
    let stream;
    try {
      if (native) await native.selectSource({ id: sourceId, audio: wantAudio });
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps }, cursor: 'always' },
        audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false } : false,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (e) {
      if (e && e.name === 'NotAllowedError' && !native) return; // cancelou no navegador
      console.warn('share (1ª tentativa)', e);
      try {
        // segunda tentativa com pedido mais simples
        if (native) await native.selectSource({ id: sourceId, audio: wantAudio });
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: wantAudio });
      } catch (e2) {
        if (wantAudio) {
          try {
            if (native) await native.selectSource({ id: sourceId, audio: false });
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            toast('Não deu para capturar o som do computador — compartilhando só a imagem.', '', 5000);
          } catch (e3) { console.warn('share', e3); }
        }
        if (!stream) {
          if (e2 && e2.name === 'NotAllowedError' && !native) return;
          console.warn('share', e2);
          toast('Não foi possível compartilhar: ' + friendlyError(e2), 'error', 5000);
          return;
        }
      }
    }
    if (!room) { stream.getTracks().forEach((t) => t.stop()); return; }

    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.contentHint = settings.hint === 'detail' ? 'detail' : 'motion';
      try { await vt.applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } }); } catch { /* ignore */ }
      vt.addEventListener('ended', () => { if (local.screen === stream) stopShare(); });
    }
    stream.getAudioTracks().forEach((t) => { t.contentHint = 'music'; });
    if (wantAudio && !stream.getAudioTracks().length && !native) toast('O som não será compartilhado (marque "compartilhar áudio" na janela do navegador).', '', 5000);

    if (local.screen) stopShare(true);
    local.screen = stream;
    room.screenQuality = q;
    stream.getTracks().forEach((t) => room.addTrack(t, stream, 'screen'));
    room.setState({ screen: true });
    Sound.on();
    render();
  }

  function stopShare(silent) {
    const s = local.screen;
    if (!s) return;
    local.screen = null;
    s.getTracks().forEach((t) => { t.stop(); room && room.removeTrack(t); });
    if (pinned === 'me:screen') pinned = null;
    if (!silent) { room && room.setState({ screen: false }); Sound.off(); }
    render();
  }

  /* ================================================================ */
  /* Pessoas e tiles                                                   */
  /* ================================================================ */
  const people = new Map(); // 'me' | peerId -> pessoa
  const tiles = new Map(); // key -> elemento
  let pinned = null;
  let lastScreenKey = null;

  function person(id) {
    let p = people.get(id);
    if (!p) {
      p = { id, name: 'Convidado', state: { mic: true, cam: false, screen: false }, main: null, screen: null, conn: 'new', volume: 1, screenVolume: 1, audioMain: null, audioScreen: null, joinedAt: Date.now(), stats: '' };
      people.set(id, p);
    }
    return p;
  }

  function hookStream(stream) {
    if (!stream || stream.__ui) return;
    stream.__ui = true;
    const hookTrack = (t) => {
      if (t.__ui) return;
      t.__ui = true;
      t.addEventListener('mute', render);
      t.addEventListener('unmute', render);
      t.addEventListener('ended', render);
    };
    stream.getTracks().forEach(hookTrack);
    stream.addEventListener('addtrack', (e) => { hookTrack(e.track); render(); });
    stream.addEventListener('removetrack', render);
  }

  // O Safari (iPhone) pode bloquear o som até um toque na tela: mostra um botão para liberar
  function playMedia(el) {
    const pr = el.play();
    if (pr && pr.catch) pr.catch((e) => { if (e && e.name === 'NotAllowedError') $('#audio-unlock').hidden = false; });
  }
  function unlockAudio() {
    $('#audio-unlock').hidden = true;
    ctx();
    for (const p of people.values()) [p.audioMain, p.audioScreen].forEach((a) => a && playMedia(a));
    $$('video').forEach((v) => v.srcObject && v.paused && playMedia(v));
  }

  function applyAudio(p) {
    if (p.id === 'me') return;
    for (const kind of ['main', 'screen']) {
      const key = kind === 'main' ? 'audioMain' : 'audioScreen';
      const stream = p[kind];
      let a = p[key];
      if (!stream) {
        if (a) { a.srcObject = null; a.remove(); p[key] = null; }
        continue;
      }
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        $('#audio-sink').appendChild(a);
        p[key] = a;
        if (settings.outId && a.setSinkId) a.setSinkId(settings.outId).catch(() => {});
      }
      if (a.srcObject !== stream) { a.srcObject = stream; playMedia(a); }
      a.volume = kind === 'main' ? p.volume : p.screenVolume;
      a.muted = deafened;
    }
  }

  function makeTile(key, kind, pid) {
    const el = document.createElement('div');
    el.className = 'tile ' + (kind === 'screen' ? 'tile-screen' : 'tile-cam');
    el.dataset.key = key;
    el.tabIndex = 0;
    el.innerHTML = `
      <video playsinline autoplay muted></video>
      <div class="tile-avatar"><div class="avatar-circle"></div></div>
      <div class="tile-loading"><div class="spinner"></div><span>Carregando a tela…</span></div>
      <div class="tile-badges"><span class="badge live">AO VIVO</span><span class="badge stats"></span><span class="badge weak">Conexão fraca</span></div>
      <div class="tile-name"><span class="mic-ind">${icon('micOff')}</span><span class="name-text"></span></div>
      <div class="tile-tools">
        <label class="vol" title="Volume">${icon('volume')}<input type="range" min="0" max="100" value="100"></label>
        <button class="tool pin" title="Fixar em destaque">${icon('pin')}</button>
        <button class="tool full" title="Tela cheia">${icon('maximize')}</button>
      </div>`;
    const full = () => {
      if (isMobile) { setImmersive(!immersive); return; }
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      if (el.requestFullscreen) { el.requestFullscreen().catch(() => {}); return; }
      if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); return; } // iPad
      const v = el.querySelector('video'); // iPhone: só o <video> entra em tela cheia (com zoom de pinça)
      if (v && v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch { /* ignore */ } }
    };
    el.querySelector('.full').addEventListener('click', (e) => { e.stopPropagation(); full(); });
    el.addEventListener('dblclick', () => { if (!isMobile) full(); }); // no celular o toque duplo é zoom
    el.querySelector('.pin').addEventListener('click', (e) => {
      e.stopPropagation();
      pinned = pinned === key ? null : key;
      render();
    });
    const range = el.querySelector('.vol input');
    range.addEventListener('input', () => {
      const p = people.get(pid);
      if (!p) return;
      const v = range.value / 100;
      if (kind === 'screen') p.screenVolume = v; else p.volume = v;
      applyAudio(p);
    });
    range.addEventListener('click', (e) => e.stopPropagation());
    range.addEventListener('dblclick', (e) => e.stopPropagation());
    return el;
  }

  function updateTile(el, p, kind) {
    const me = p.id === 'me';
    const stream = kind === 'screen' ? (me ? local.screen : p.screen) : (me ? local.main : p.main);
    const video = el.querySelector('video');
    if (video.srcObject !== (stream || null)) {
      video.srcObject = stream || null;
      if (stream) video.play().catch(() => {});
    }
    const vt = stream ? stream.getVideoTracks().find((t) => t.readyState === 'live') : null;
    let showVideo;
    if (me) showVideo = kind === 'screen' ? !!vt : !!local.cam;
    else showVideo = !!vt && !vt.muted && (kind === 'screen' || p.state.cam !== false);
    el.classList.toggle('has-video', showVideo);
    el.classList.toggle('mirror', me && kind === 'cam' && mirrorMe());
    el.classList.toggle('is-me', me);
    el.classList.toggle('pinned', pinned === el.dataset.key);
    el.querySelector('.pin').classList.toggle('active', pinned === el.dataset.key);
    const micOn = me ? local.micOn && !!local.mic && !deafened : p.state.mic !== false;
    el.classList.toggle('muted', kind === 'cam' && !micOn);
    el.classList.toggle('no-audio', kind === 'screen' && !(stream && stream.getAudioTracks().length));
    el.classList.toggle('conn-bad', !me && kind === 'cam' && (p.conn === 'disconnected' || p.conn === 'failed'));
    const name = me ? myName() + ' (você)' : p.name;
    const label = kind === 'screen' ? (me ? 'Sua tela' : 'Tela de ' + p.name) : name;
    const nt = el.querySelector('.name-text');
    if (nt.textContent !== label) nt.textContent = label;
    const av = el.querySelector('.avatar-circle');
    const n = me ? myName() : p.name;
    av.textContent = initial(n);
    av.style.background = colorFor(n + (me ? '' : p.id));
    const st = el.querySelector('.badge.stats');
    const stats = kind === 'screen' && !me ? p.stats : '';
    if (st.textContent !== stats) st.textContent = stats;
  }

  function ensureTile(key, kind, pid, wanted) {
    let el = tiles.get(key);
    if (wanted && !el) { el = makeTile(key, kind, pid); tiles.set(key, el); }
    if (!wanted && el) {
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      el.querySelector('video').srcObject = null;
      el.remove();
      tiles.delete(key);
      if (pinned === key) pinned = null;
      el = null;
    }
    return el;
  }

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  function renderNow() {
    syncPhone();
    renderControls();
    if (!room) return;
    const order = [];
    const ids = [...people.keys()].filter((id) => id !== 'me').sort((a, b) => people.get(a).joinedAt - people.get(b).joinedAt);
    for (const id of ids) {
      const p = people.get(id);
      const ct = ensureTile(id + ':cam', 'cam', id, true);
      updateTile(ct, p, 'cam');
      const st = ensureTile(id + ':screen', 'screen', id, !!p.state.screen);
      if (st) updateTile(st, p, 'screen');
      if (st) order.unshift(st);
      order.push(ct);
    }
    const me = person('me');
    const myScreen = ensureTile('me:screen', 'screen', 'me', !!local.screen);
    if (myScreen) { updateTile(myScreen, me, 'screen'); order.push(myScreen); }
    const myCam = ensureTile('me:cam', 'cam', 'me', true);
    updateTile(myCam, me, 'cam');
    order.push(myCam);
    layout(order);

    $('#people-count b').textContent = String(people.size);
    renderStatus();
  }

  function place(container, els) {
    els.forEach((el, i) => {
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    });
    while (container.children.length > els.length) {
      const extra = container.children[els.length];
      extra.remove();
    }
  }

  let inviteTile = null;
  function getInviteTile() {
    if (!inviteTile) {
      inviteTile = document.createElement('div');
      inviteTile.className = 'tile invite-tile';
      inviteTile.innerHTML = `<div class="invite"><h3>Chame alguém pra sala</h3><p>Envie este código para a outra pessoa:</p><div class="big-code"></div><button class="btn primary">${icon('copy')}Copiar código</button></div>`;
      inviteTile.querySelector('button').addEventListener('click', copyRoomCode);
    }
    inviteTile.querySelector('.big-code').textContent = formatCode(room ? room.code : '');
    return inviteTile;
  }

  function layout(order) {
    const area = $('#stage-area');
    const screenKeys = order.filter((el) => el.classList.contains('tile-screen') && el.dataset.key !== 'me:screen').map((el) => el.dataset.key);
    if (screenKeys.length && !screenKeys.includes(lastScreenKey)) lastScreenKey = screenKeys[0];
    if (!screenKeys.length) lastScreenKey = null;
    let featuredKey = (pinned && tiles.has(pinned) && pinned) || lastScreenKey;
    // no celular, numa chamada a dois, a outra pessoa ocupa a tela e você fica pequeno embaixo
    if (!featuredKey && isMobile && order.length === 2) {
      const other = order.find((el) => el.dataset.key !== 'me:cam');
      if (other) featuredKey = other.dataset.key;
    }
    const featured = featuredKey ? tiles.get(featuredKey) : null;
    const pip = featured && isMobile ? pipFor(featuredKey, order) : null;
    order.forEach((el) => { if (el !== pip) { el.classList.remove('pip'); delete el.dataset.corner; } });

    if (featured && order.length > 1) {
      const rest = order.filter((el) => el !== featured && el !== pip);
      area.className = 'focus-mode' + (rest.length ? '' : ' no-strip');
      $('#grid').replaceChildren();
      if (pip) { pip.classList.add('pip'); pip.dataset.corner = pipCorner; }
      place($('#stage'), pip ? [featured, pip] : [featured]);
      place($('#strip'), rest);
      setZoomTarget(featured.classList.contains('tile-screen') ? featured.querySelector('video') : null);
    } else {
      setZoomTarget(null);
      area.className = 'grid-mode';
      $('#stage').replaceChildren();
      $('#strip').replaceChildren();
      const els = people.size === 1 ? [getInviteTile(), ...order] : order;
      place($('#grid'), els);
      sizeGrid();
    }
    // garante que vídeos movidos continuem tocando
    order.forEach((el) => { const v = el.querySelector('video'); if (v.srcObject && v.paused) playMedia(v); });
  }

  /* ---------- celular: miniatura no canto, tela cheia e zoom ---------- */
  let pipCorner = 'br';
  let immersive = false;

  // quem vai para a miniatura: a câmera de quem está compartilhando (ou a tela dela, se a câmera
  // estiver em destaque); numa chamada a dois sem tela, você mesmo
  function pipFor(featuredKey, order) {
    const [id, kind] = featuredKey.split(':');
    let key = null;
    if (kind === 'screen' && id !== 'me') key = id + ':cam';
    else if (kind === 'cam' && tiles.has(id + ':screen') && id !== 'me') key = id + ':screen';
    else if (kind === 'cam' && id !== 'me' && order.length === 2) key = 'me:cam';
    else if (kind === 'cam' && id === 'me' && order.length === 2) { const o = order.find((el) => el.dataset.key !== 'me:cam'); key = o && o.dataset.key; }
    const el = key ? tiles.get(key) : null;
    return el && order.includes(el) ? el : null;
  }

  function setImmersive(on) {
    immersive = on;
    $('#call').classList.toggle('immersive', on);
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); // Android
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (!on) resetZoom();
    render();
  }
  document.addEventListener('fullscreenchange', () => { if (isMobile && !document.fullscreenElement && immersive) setImmersive(false); });

  // arrastar a miniatura para um canto; um toque troca miniatura e destaque
  (function pipDrag() {
    const stage = $('#stage');
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.tile.pip');
      if (!el || e.target.closest('.tool')) return;
      const r = el.getBoundingClientRect();
      drag = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, left: r.left, top: r.top, moved: false };
      el.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      drag.el.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      d.el.classList.remove('dragging');
      d.el.style.transform = '';
      if (!d.moved) { pinned = d.el.dataset.key; resetZoom(); render(); return; }
      const sr = stage.getBoundingClientRect();
      const r = d.el.getBoundingClientRect();
      const cx = d.left + (e.clientX - d.x0) + r.width / 2, cy = d.top + (e.clientY - d.y0) + r.height / 2;
      pipCorner = (cy < sr.top + sr.height / 2 ? 't' : 'b') + (cx < sr.left + sr.width / 2 ? 'l' : 'r');
      d.el.dataset.corner = pipCorner;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  })();

  // zoom de pinça / arrastar / toque duplo na tela compartilhada em destaque
  const zoom = { el: null, s: 1, x: 0, y: 0 };
  function applyZoom() {
    if (!zoom.el) return;
    const w = zoom.el.clientWidth, h = zoom.el.clientHeight;
    const mx = ((zoom.s - 1) * w) / 2, my = ((zoom.s - 1) * h) / 2;
    zoom.x = Math.max(-mx, Math.min(mx, zoom.x));
    zoom.y = Math.max(-my, Math.min(my, zoom.y));
    zoom.el.style.transform = zoom.s > 1.01 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : '';
    zoom.el.closest('.tile').classList.toggle('zoomed', zoom.s > 1.01);
  }
  function resetZoom() { zoom.s = 1; zoom.x = 0; zoom.y = 0; applyZoom(); }
  function setZoomTarget(v) {
    if (!isMobile || zoom.el === v) return;
    if (zoom.el) { zoom.el.style.transform = ''; const t = zoom.el.closest('.tile'); if (t) t.classList.remove('zoomed'); }
    zoom.el = v;
    zoom.s = 1; zoom.x = 0; zoom.y = 0;
  }
  (function pinchZoom() {
    if (!isMobile) return;
    const stage = $('#stage');
    let g = null, lastTap = 0;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTarget = (e) => zoom.el && e.target.closest('.tile') === zoom.el.closest('.tile') && !e.target.closest('.tool, .pip');
    stage.addEventListener('touchstart', (e) => {
      if (!onTarget(e)) return;
      if (e.touches.length === 2) {
        g = { mode: 'pinch', d0: dist(e.touches), s0: zoom.s };
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          // toque duplo: aproxima no ponto tocado ou volta ao normal
          if (zoom.s > 1.01) resetZoom();
          else {
            const r = zoom.el.getBoundingClientRect();
            zoom.s = 2.5;
            zoom.x = (r.left + r.width / 2 - e.touches[0].clientX) * 1.5;
            zoom.y = (r.top + r.height / 2 - e.touches[0].clientY) * 1.5;
            applyZoom();
          }
          lastTap = 0;
          g = null;
          e.preventDefault();
          return;
        }
        lastTap = now;
        g = zoom.s > 1.01 ? { mode: 'pan', x0: e.touches[0].clientX, y0: e.touches[0].clientY, zx: zoom.x, zy: zoom.y } : null;
      }
    }, { passive: false });
    stage.addEventListener('touchmove', (e) => {
      if (!g) return;
      if (g.mode === 'pinch' && e.touches.length === 2) {
        zoom.s = Math.max(1, Math.min(5, (g.s0 * dist(e.touches)) / g.d0));
        applyZoom();
        e.preventDefault();
      } else if (g.mode === 'pan' && e.touches.length === 1) {
        zoom.x = g.zx + (e.touches[0].clientX - g.x0);
        zoom.y = g.zy + (e.touches[0].clientY - g.y0);
        applyZoom();
        e.preventDefault();
      }
    }, { passive: false });
    stage.addEventListener('touchend', (e) => { if (!e.touches.length) g = null; else if (g && g.mode === 'pinch' && e.touches.length === 1) g = null; });
  })();

  function sizeGrid() {
    const grid = $('#grid');
    const n = grid.children.length;
    if (!n) return;
    const W = grid.clientWidth, H = grid.clientHeight, gap = 12;
    let best = { c: 1, w: 0, h: 0 };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      let w = (W - gap * (c - 1)) / c;
      let h = (w * 9) / 16;
      if (h * r + gap * (r - 1) > H) { h = (H - gap * (r - 1)) / r; w = (h * 16) / 9; }
      if (w * h > best.w * best.h) best = { c, w, h };
    }
    grid.style.gridTemplateColumns = `repeat(${best.c}, ${Math.floor(best.w)}px)`;
    grid.style.gridAutoRows = `${Math.floor(best.h)}px`;
  }
  new ResizeObserver(() => { if (room) sizeGrid(); }).observe($('#stage-area'));

  function renderStatus() {
    const el = $('#net-status');
    const remotes = [...people.values()].filter((p) => p.id !== 'me');
    let cls = 'ok', text = 'Conectado';
    if (signalState === 'offline') { cls = 'bad'; text = 'Sem conexão com o servidor — tentando de novo…'; }
    else if (!remotes.length) { cls = 'ok'; text = 'Sala aberta'; }
    else if (remotes.some((p) => p.conn === 'failed' || p.conn === 'disconnected')) { cls = 'bad'; text = 'Reconectando…'; }
    else if (remotes.some((p) => p.conn !== 'connected')) { cls = ''; text = 'Conectando…'; }
    el.className = 'status ' + cls;
    el.querySelector('span').textContent = text;
  }

  function setCtrl(btn, ico, label, state) {
    const i = btn.querySelector('.ctrl-ico');
    if (i.dataset.cur !== ico) { i.innerHTML = icon(ico); i.dataset.cur = ico; }
    btn.querySelector('.ctrl-label').textContent = label;
    btn.classList.toggle('off', state === 'off');
    btn.classList.toggle('on', state === 'on');
  }

  function renderControls() {
    const micOn = local.micOn && !!local.mic && !deafened;
    setCtrl($('#btn-mic'), micOn ? 'mic' : 'micOff', micOn ? 'Microfone' : 'Mudo', micOn ? '' : 'off');
    setCtrl($('#btn-cam'), local.cam ? 'video' : 'videoOff', 'Câmera', local.cam ? '' : 'off');
    setCtrl($('#btn-share'), local.screen ? 'screenOff' : 'screen', local.screen ? 'Parar' : 'Tela', local.screen ? 'on' : '');
    setCtrl($('#btn-deaf'), deafened ? 'headphonesOff' : 'headphones', deafened ? 'Sem som' : 'Áudio', deafened ? 'off' : '');
    $('#self-name').textContent = myName();

    // prévia da tela inicial
    const pm = $('#pre-mic'), pc = $('#pre-cam');
    pm.innerHTML = icon(local.micOn && local.mic ? 'mic' : 'micOff');
    pm.classList.toggle('off', !(local.micOn && local.mic));
    pc.innerHTML = icon(local.cam ? 'video' : 'videoOff');
    pc.classList.toggle('off', !local.cam);
    const pt = $('#preview-tile');
    pt.classList.toggle('has-video', !!local.cam);
    pt.classList.toggle('mirror', mirrorMe());
    const pv = $('#preview-video');
    if (pv.srcObject !== local.main) pv.srcObject = local.main;
    const pa = $('#preview-avatar');
    pa.textContent = initial(myName());
    pa.style.background = colorFor(myName());
  }

  /* ================================================================ */
  /* Indicador de fala                                                 */
  /* ================================================================ */
  const meters = new Map();
  function levelOf(key, track) {
    if (!track || track.readyState !== 'live') { dropMeter(key); return 0; }
    let m = meters.get(key);
    if (!m || m.trackId !== track.id) {
      dropMeter(key);
      try {
        const a = ctx();
        const src = a.createMediaStreamSource(new MediaStream([track]));
        const an = a.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        m = { src, an, trackId: track.id, buf: new Float32Array(an.fftSize), hold: 0 };
        meters.set(key, m);
      } catch { return 0; }
    }
    m.an.getFloatTimeDomainData(m.buf);
    let s = 0;
    for (let i = 0; i < m.buf.length; i++) s += m.buf[i] * m.buf[i];
    return Math.sqrt(s / m.buf.length);
  }
  function dropMeter(key) {
    const m = meters.get(key);
    if (m) { try { m.src.disconnect(); } catch { /* ignore */ } meters.delete(key); }
  }

  setInterval(() => {
    const micLive = local.mic && local.micOn && !deafened;
    const myLevel = micLive ? levelOf('me', local.mic) : (dropMeter('me'), 0);
    const pct = Math.min(100, Math.round(myLevel * 450));
    $('#preview-meter-bar').style.width = pct + '%';
    $('#set-meter-bar').style.width = pct + '%';
    if (!room) return;
    for (const p of people.values()) {
      const el = tiles.get(p.id + ':cam');
      if (!el) continue;
      const lvl = p.id === 'me' ? myLevel : (p.main && p.state.mic !== false ? levelOf(p.id, p.main.getAudioTracks()[0]) : 0);
      const m = meters.get(p.id);
      const now = Date.now();
      if (lvl > 0.018) { if (m) m.hold = now + 280; }
      el.classList.toggle('speaking', !!m && m.hold > now);
    }
  }, 90);

  /* ---------- estatísticas da tela recebida ---------- */
  setInterval(async () => {
    if (!room) return;
    for (const p of people.values()) {
      if (p.id === 'me' || !p.screen) { if (p.stats) { p.stats = ''; render(); } continue; }
      const pc = room.peerConnection(p.id);
      const vt = p.screen.getVideoTracks()[0];
      if (!pc || !vt) continue;
      try {
        const rep = await pc.getStats(vt);
        let txt = '';
        rep.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameHeight) txt = `${r.frameHeight}p · ${Math.round(r.framesPerSecond || 0)} fps`;
        });
        if (txt !== p.stats) { p.stats = txt; render(); }
      } catch { /* ignore */ }
    }
  }, 2000);

  /* ================================================================ */
  /* Sala                                                              */
  /* ================================================================ */
  let signalState = 'online';
  let busy = false;

  function setHomeError(msg) {
    const el = $('#home-error');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  function setBusy(v, which) {
    busy = v;
    $('#btn-create').disabled = v;
    $('#btn-join').disabled = v;
    if (which === 'create') $('#btn-create').lastChild.textContent = v ? 'Criando sala…' : 'Criar uma sala';
    if (which === 'join') $('#btn-join').firstChild.textContent = v ? 'Entrando…' : 'Entrar';
  }

  function readName() {
    const n = $('#name-input').value.trim();
    if (!n) {
      $('#name-input').focus();
      setHomeError('Digite seu nome antes de continuar.');
      return false;
    }
    settings.name = n.slice(0, 32);
    saveSettings();
    return true;
  }

  async function enterRoom(mode, code) {
    if (busy) return;
    setHomeError('');
    if (!readName()) return;
    if (typeof Peer === 'undefined') { setHomeError('Componente de conexão não carregou. Reinstale o app.'); return; }
    ctx(); // libera áudio após o clique
    setBusy(true, mode);
    const r = new Room({ name: myName(), iceServers: iceServers(), server: signalServer() });
    wireRoom(r);
    r.state = { mic: local.micOn && !!local.mic, cam: !!local.cam, screen: false, deaf: false };
    for (const t of local.main.getTracks()) r.addTrack(t, local.main, 'main');
    try {
      if (mode === 'create') await r.create();
      else await r.join(code);
    } catch (e) {
      console.warn('room', e);
      r.leave();
      setBusy(false, mode);
      setHomeError(friendlyError(e));
      return;
    }
    room = r;
    setBusy(false, mode);
    people.clear();
    person('me').name = myName();
    $('#room-code').textContent = formatCode(r.code);
    $('#chat-list').replaceChildren();
    addSystemMsg(mode === 'create' ? 'Sala criada. Envie o código ' + formatCode(r.code) + ' para quem você quer chamar.' : 'Você entrou na sala.');
    unread = 0;
    $('#chat-badge').hidden = true;
    showView('call');
    keepAwake(true);
    try { history.replaceState(null, '', '#' + r.code); } catch { /* ignore */ }
    if (mode === 'create') {
      copyText(formatCode(r.code)).then((ok) => ok && toast('Código ' + formatCode(r.code) + ' copiado — é só colar no WhatsApp!', 'ok', 4500));
    }
    render();
  }

  function wireRoom(r) {
    r.on('peer-join', (id, name, state) => {
      if (r !== room && room) return;
      const existed = people.has(id);
      const p = person(id);
      p.name = name;
      p.state = { ...p.state, ...state };
      if (!existed) {
        Sound.join();
        toast(name + ' entrou na sala');
        addSystemMsg(name + ' entrou');
        notify(name + ' entrou na sala');
      }
      render();
    });
    r.on('peer-state', (id, state, name) => {
      const p = person(id);
      const wasSharing = p.state.screen;
      p.state = { ...p.state, ...state };
      if (name) p.name = name;
      if (!p.state.screen && p.screen) { p.screen = null; applyAudio(p); }
      if (p.state.screen && !wasSharing) toast(p.name + ' começou a compartilhar a tela');
      render();
    });
    r.on('peer-track', (id, kind, stream) => {
      const p = person(id);
      hookStream(stream);
      if (kind === 'screen') {
        p.screen = stream.getTracks().length ? stream : null;
      } else {
        p.main = stream;
      }
      applyAudio(p);
      render();
    });
    r.on('peer-conn', (id, s) => {
      const p = people.get(id);
      if (!p) return;
      p.conn = s;
      render();
    });
    r.on('peer-leave', (id, name, reason) => {
      const p = people.get(id);
      if (!p) return;
      p.main = null;
      p.screen = null;
      applyAudio(p);
      dropMeter(id);
      people.delete(id);
      ensureTile(id + ':cam', 'cam', id, false);
      ensureTile(id + ':screen', 'screen', id, false);
      Sound.leave();
      toast(reason === 'lost' || reason === 'close' ? 'A conexão com ' + name + ' caiu' : name + ' saiu da sala');
      addSystemMsg(name + ' saiu');
      render();
    });
    r.on('chat', (id, name, text, ts) => addChatMsg(name, text, ts, colorFor(name + id)));
    r.on('signal', (s) => { signalState = s; render(); });
  }

  async function leaveRoom() {
    if (!room) return;
    const r = room;
    stopShare(true);
    room = null;
    await r.leave().catch(() => {});
    for (const p of people.values()) { p.main = null; p.screen = null; applyAudio(p); }
    for (const key of [...tiles.keys()]) ensureTile(key, '', '', false);
    meters.forEach((_, k) => k !== 'me' && dropMeter(k));
    people.clear();
    pinned = null;
    lastScreenKey = null;
    if (deafened) setDeaf(false);
    closeChat();
    keepAwake(false);
    if (immersive) setImmersive(false);
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    showView('home');
    Sound.leave();
    render();
  }

  /* ---------- tela ligada durante a chamada + volta do segundo plano (celular) ---------- */
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && navigator.wakeLock && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch { /* ignore */ }
  }
  let hiddenWith = null;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenWith = { cam: !!local.cam }; return; }
    if (room) keepAwake(true);
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    // o iOS encerra câmera/microfone de sites em segundo plano: religa o que estava ligado
    const was = hiddenWith || { cam: false };
    hiddenWith = null;
    let restored = false;
    if (local.micOn && !(local.mic && local.mic.readyState === 'live')) {
      if (local.mic) { const old = local.mic; local.mic = null; local.main.removeTrack(old); if (room) room.removeTrack(old); }
      if (await ensureMic()) restored = true;
      if (room) room.setState({ mic: local.micOn && !deafened });
    }
    if (was.cam && !(local.cam && local.cam.readyState === 'live')) {
      if (local.cam) stopCam();
      if (await startCam()) restored = true;
      if (room) room.setState({ cam: !!local.cam });
    }
    if (restored && room) toast('Câmera e microfone religados', 'ok');
    render();
  });

  function copyRoomCode() {
    if (!room) return;
    copyText(formatCode(room.code)).then((ok) => toast(ok ? 'Código copiado!' : 'Não consegui copiar', ok ? 'ok' : 'error'));
  }

  function showView(v) {
    $('#home').hidden = v !== 'home';
    $('#call').hidden = v !== 'call';
  }

  function notify(text) {
    if (!document.hidden && document.hasFocus()) return;
    native && native.flash();
    try { if (Notification.permission === 'granted') new Notification('Wecord', { body: text, silent: true }); } catch { /* ignore */ }
  }

  /* ================================================================ */
  /* Chat                                                              */
  /* ================================================================ */
  let unread = 0;
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function addChatMsg(name, text, ts, color, mine) {
    const list = $('#chat-list');
    const div = document.createElement('div');
    div.className = 'msg';
    const head = document.createElement('div');
    head.className = 'msg-head';
    const b = document.createElement('b');
    b.textContent = name;
    b.style.color = color;
    const t = document.createElement('time');
    t.textContent = fmtTime(ts);
    head.append(b, t);
    const body = document.createElement('div');
    body.className = 'msg-text';
    body.textContent = text;
    div.append(head, body);
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.appendChild(div);
    if (atBottom || mine) list.scrollTop = list.scrollHeight;
    if (!mine) {
      if ($('#chat-panel').hidden) { unread++; $('#chat-badge').hidden = false; }
      Sound.msg();
      notify(name + ': ' + text.slice(0, 80));
    }
  }
  function addSystemMsg(text) {
    const div = document.createElement('div');
    div.className = 'msg-sys';
    div.textContent = text;
    $('#chat-list').appendChild(div);
  }
  function openChat() {
    $('#chat-panel').hidden = false;
    unread = 0;
    $('#chat-badge').hidden = true;
    $('#btn-chat').classList.add('on');
    $('#chat-input').focus();
    const list = $('#chat-list');
    list.scrollTop = list.scrollHeight;
  }
  function closeChat() {
    $('#chat-panel').hidden = true;
    $('#btn-chat').classList.remove('on');
  }
  $('#btn-chat').addEventListener('click', () => ($('#chat-panel').hidden ? openChat() : closeChat()));
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || !room) return;
    room.sendChat(text);
    addChatMsg(myName(), text, Date.now(), colorFor(myName()), true);
    input.value = '';
  });

  /* ================================================================ */
  /* Seletor de tela                                                   */
  /* ================================================================ */
  let sources = [];
  let pickerTab = 'screen';
  let selectedSource = null;

  const qSel = $('#opt-quality');
  for (const [k, q] of Object.entries(QUALITY)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = q.label + (k === '1080p30' ? ' (recomendado)' : '');
    qSel.appendChild(o);
  }

  async function openPicker() {
    if (local.screen) { stopShare(); return; }
    const dlg = $('#picker');
    qSel.value = settings.quality;
    $('#opt-hint').value = settings.hint;
    $('#opt-audio').checked = settings.shareAudio;
    $('#opt-audio-wrap').hidden = !canShareSystemAudio;
    selectedSource = null;
    $('#picker-go').disabled = !!native;
    $('#picker-tabs').hidden = !native;
    $('#source-grid').hidden = !native;
    $('#browser-note').hidden = !!native;
    dlg.showModal();
    if (native) await loadSources();
  }

  async function loadSources() {
    const grid = $('#source-grid');
    if (!sources.length) grid.innerHTML = '<div class="source-empty"><div class="spinner"></div>Procurando telas e janelas…</div>';
    try {
      sources = await native.getSources();
    } catch (e) {
      grid.innerHTML = '<div class="source-empty">Não consegui listar as telas.</div>';
      return;
    }
    if (selectedSource && !sources.some((s) => s.id === selectedSource)) selectedSource = null;
    renderSources();
  }

  function renderSources() {
    const grid = $('#source-grid');
    $$('#picker-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === pickerTab));
    const list = sources.filter((s) => s.type === pickerTab);
    if (pickerTab === 'screen' && !selectedSource && list.length) selectedSource = list[0].id;
    grid.replaceChildren();
    if (!list.length) {
      grid.innerHTML = `<div class="source-empty">${pickerTab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta encontrada.'}</div>`;
    }
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'source' + (s.id === selectedSource ? ' selected' : '');
      const th = document.createElement('div');
      th.className = 'source-thumb';
      if (s.thumbnail) th.style.backgroundImage = `url("${s.thumbnail}")`;
      else th.innerHTML = icon(s.type === 'screen' ? 'screen' : 'window');
      const nm = document.createElement('div');
      nm.className = 'source-name';
      if (s.icon) { const img = document.createElement('img'); img.src = s.icon; img.alt = ''; nm.appendChild(img); }
      const sp = document.createElement('span');
      sp.textContent = s.name;
      sp.title = s.name;
      nm.appendChild(sp);
      b.append(th, nm);
      b.addEventListener('click', () => { selectedSource = s.id; renderSources(); });
      b.addEventListener('dblclick', () => { selectedSource = s.id; confirmPicker(); });
      grid.appendChild(b);
    }
    $('#picker-go').disabled = !selectedSource || !sources.some((s) => s.id === selectedSource);
  }

  function confirmPicker() {
    if (native && !selectedSource) return;
    settings.quality = qSel.value;
    settings.hint = $('#opt-hint').value;
    settings.shareAudio = $('#opt-audio').checked;
    saveSettings();
    $('#picker').close();
    startShare(selectedSource);
  }

  $$('#picker-tabs .tab').forEach((t) => t.addEventListener('click', () => { pickerTab = t.dataset.tab; renderSources(); }));
  $('#picker-refresh').addEventListener('click', loadSources);
  $('#picker-go').addEventListener('click', confirmPicker);

  /* ================================================================ */
  /* Configurações                                                     */
  /* ================================================================ */
  async function refreshDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const fill = (sel, kind, current, fallback) => {
      const list = devs.filter((d) => d.kind === kind);
      sel.replaceChildren();
      const def = document.createElement('option');
      def.value = '';
      def.textContent = fallback;
      sel.appendChild(def);
      list.forEach((d, i) => {
        if (d.deviceId === 'default' || d.deviceId === 'communications') return;
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${fallback.split(' ')[0]} ${i + 1}`;
        sel.appendChild(o);
      });
      if (sel.id === 'set-mic' || sel.id === 'set-cam') {
        const o = document.createElement('option');
        o.value = 'phone';
        o.textContent = phone && phone.connected ? 'Celular (conectado)' : 'Celular (conectar…)';
        sel.appendChild(o);
      }
      sel.value = current === 'phone' ? 'phone' : list.some((d) => d.deviceId === current) ? current : '';
    };
    fill($('#set-mic'), 'audioinput', settings.micId, 'Padrão do sistema');
    fill($('#set-cam'), 'videoinput', settings.camId, 'Padrão do sistema');
    fill($('#set-out'), 'audiooutput', settings.outId, 'Padrão do sistema');
    $('#set-out').disabled = !HTMLMediaElement.prototype.setSinkId;
  }
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  function openSettings() {
    refreshDevices();
    $('#set-noise').checked = settings.noise;
    $('#set-sounds').checked = settings.sounds;
    $('#set-turn-url').value = settings.turnUrl;
    $('#set-turn-user').value = settings.turnUser;
    $('#set-turn-pass').value = settings.turnPass;
    $('#set-server-host').value = settings.serverHost;
    $('#set-server-port').value = settings.serverPort;
    $('#set-server-path').value = settings.serverPath;
    $('#settings').showModal();
  }

  function pickDevice(kind, value) {
    if (kind === 'audio') settings.micId = value; else settings.camId = value;
    saveSettings();
    if (value === 'phone' && !(phone && phone.connected)) { openPhone(); return; }
    if (kind === 'video' && value === 'phone') phoneCamWanted = true;
    swapDevice(kind);
  }
  $('#set-mic').addEventListener('change', (e) => pickDevice('audio', e.target.value));
  $('#set-cam').addEventListener('change', (e) => pickDevice('video', e.target.value));
  $('#set-phone').addEventListener('click', openPhone);
  $('#pre-phone').addEventListener('click', openPhone);
  $('#phone-copy').addEventListener('click', () => copyText($('#phone-url').value).then((ok) => toast(ok ? 'Link copiado!' : 'Não consegui copiar', ok ? 'ok' : 'error')));
  $('#phone-reset').addEventListener('click', () => {
    stopPhone();
    settings.phoneCode = newCode();
    saveSettings();
    openPhone();
    toast('Código novo gerado. Escaneie de novo no celular.');
  });
  $('#phone-stop').addEventListener('click', () => { stopPhone(); $('#phone-dialog').close(); toast('O celular não será mais usado.'); });
  $('#phone-dialog').addEventListener('close', refreshDevices);
  $('#set-out').addEventListener('change', (e) => {
    settings.outId = e.target.value;
    saveSettings();
    for (const p of people.values()) {
      [p.audioMain, p.audioScreen].forEach((a) => a && a.setSinkId && a.setSinkId(settings.outId).catch(() => {}));
    }
    if (audioCtx && audioCtx.setSinkId) audioCtx.setSinkId(settings.outId).catch(() => {});
  });
  $('#set-test-sound').addEventListener('click', () => { const was = settings.sounds; settings.sounds = true; Sound.join(); settings.sounds = was; });
  $('#set-noise').addEventListener('change', (e) => { settings.noise = e.target.checked; saveSettings(); swapDevice('audio'); });
  $('#set-sounds').addEventListener('change', (e) => { settings.sounds = e.target.checked; saveSettings(); });
  const bindText = (id, key) => $(id).addEventListener('change', (e) => { settings[key] = e.target.value.trim(); saveSettings(); if (room) toast('Vale a partir da próxima sala que você entrar.'); });
  bindText('#set-turn-url', 'turnUrl');
  bindText('#set-turn-user', 'turnUser');
  bindText('#set-turn-pass', 'turnPass');
  bindText('#set-server-host', 'serverHost');
  bindText('#set-server-port', 'serverPort');
  bindText('#set-server-path', 'serverPath');

  // fechar modais
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  /* ================================================================ */
  /* Eventos da interface                                              */
  /* ================================================================ */
  $('#btn-mic').addEventListener('click', toggleMic);
  $('#btn-cam').addEventListener('click', toggleCam);
  $('#btn-share').addEventListener('click', openPicker);
  $('#btn-deaf').addEventListener('click', () => setDeaf(!deafened));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#room-chip').addEventListener('click', copyRoomCode);
  $('#pre-mic').addEventListener('click', toggleMic);
  $('#pre-cam').addEventListener('click', toggleCam);
  $('#pre-settings').addEventListener('click', openSettings);
  $('#btn-flip').addEventListener('click', flipCam);
  $('#pre-flip').addEventListener('click', flipCam);
  $('#audio-unlock').addEventListener('click', unlockAudio);
  $('#btn-share').hidden = !canShareScreen;

  // celular deitado: os controles somem sozinhos para a tela compartilhada ocupar tudo; um toque traz de volta
  if (isMobile) {
    let idleTimer = 0;
    const wake = () => {
      $('#call').classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => $('#call').classList.add('idle'), 4000);
    };
    $('#call').addEventListener('pointerdown', wake);
    addEventListener('orientationchange', wake);
    wake();
  }

  $('#btn-create').addEventListener('click', () => enterRoom('create'));
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('#code-input').value);
    if (code.length !== 6) { setHomeError('O código tem 6 caracteres, por exemplo ABC-123.'); $('#code-input').focus(); return; }
    enterRoom('join', code);
  });
  $('#code-input').addEventListener('input', (e) => {
    const c = normalizeCode(e.target.value);
    e.target.value = c.length > 3 ? c.slice(0, 3) + '-' + c.slice(3) : c;
    setHomeError('');
  });
  $('#code-input').addEventListener('paste', () => setTimeout(() => $('#code-input').dispatchEvent(new Event('input')), 0));
  $('#name-input').addEventListener('input', (e) => {
    settings.name = e.target.value.trim().slice(0, 32);
    saveSettings();
    setHomeError('');
    render();
  });
  $('#name-input').addEventListener('change', () => { if (room) room.setName(myName()); });

  document.addEventListener('keydown', (e) => {
    if (!room || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'v') toggleCam();
    else if (k === 's' && canShareScreen) openPicker();
    else if (k === 'd') setDeaf(!deafened);
    else return;
    e.preventDefault();
  });

  /* ---------- atualização automática ---------- */
  let updateDismissed = false;
  function showUpdate(u) {
    const bar = $('#update-bar');
    if (!u || u.status === 'idle') { bar.hidden = true; return; }
    if (u.status === 'downloading') {
      $('#update-text').textContent = 'Baixando atualização' + (u.version ? ' v' + u.version : '') + '… ' + (u.percent || 0) + '%';
      $('#btn-update').hidden = true;
      $('#btn-update-later').hidden = true;
      bar.classList.remove('ready');
      bar.hidden = !!room; // durante a chamada, baixa em silêncio
    } else if (u.status === 'ready') {
      $('#update-text').textContent = 'Nova versão v' + u.version + ' pronta!';
      $('#btn-update').hidden = false;
      $('#btn-update-later').hidden = false;
      bar.classList.add('ready');
      bar.hidden = updateDismissed;
    }
  }
  $('#btn-update').addEventListener('click', async () => {
    if (room && !confirm('Atualizar agora vai te tirar da chamada. Continuar?')) return;
    if (room) room.leave();
    $('#update-text').textContent = 'Reiniciando…';
    $('#btn-update').hidden = true;
    const ok = await native.installUpdate().catch(() => false);
    if (!ok) { $('#update-bar').hidden = true; toast('Não consegui atualizar agora — tente fechar e abrir o Wecord.', 'error', 5000); }
  });
  $('#btn-update-later').addEventListener('click', () => {
    updateDismissed = true;
    $('#update-bar').hidden = true;
    toast('Tudo bem! A atualização será instalada quando você fechar o Wecord.', 'ok', 4500);
  });

  window.addEventListener('beforeunload', () => { if (room) room.leave(); });

  /* ================================================================ */
  /* Início                                                            */
  /* ================================================================ */
  async function init() {
    hydrateIcons();
    $('#name-input').value = settings.name;
    const hash = normalizeCode(location.hash);
    if (hash.length === 6) $('#code-input').value = formatCode(hash);
    if (native) {
      native.info().then((i) => {
        $('#app-version').textContent = 'v' + i.version;
        $('#settings-version').textContent = 'Wecord v' + i.version;
      }).catch(() => {});
    }
    if (native && native.onUpdate) {
      native.onUpdate(showUpdate);
      native.updateState().then(showUpdate).catch(() => {});
    }
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* ignore */ }
    if (settings.phoneCode && (settings.micId === 'phone' || settings.camId === 'phone')) ensurePhoneLink();
    renderPhone();
    render();
    await ensureMic();
    if (local.camOn) await startCam();
    render();
    if (!settings.name) $('#name-input').focus();
    else if (hash.length === 6) $('#btn-join').focus();
  }
  // gancho para diagnóstico (F12 → console: __wecord)
  window.__wecord = { people, local, settings, get room() { return room; } };
  init();
})();
