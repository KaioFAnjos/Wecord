/* Wecord — usar o celular como câmera/microfone do PC (lado do PC)
 *
 * O PC abre um peer fixo "wecord-v1-cam-<código>" no servidor de sinalização.
 * O celular abre phone.html#c=<código> (QR code), conecta um canal de controle e
 * faz uma chamada de mídia enviando câmera + microfone. O PC não envia nada de volta:
 * só usa as faixas recebidas como se fossem dispositivos locais.
 *
 * Mensagens no canal (JSON):
 *   celular → PC  { t:'hello', video:bool, audio:bool, facing }   capacidades do celular
 *                 { t:'cam', on:bool }                              botão de câmera do celular
 *   PC → celular  { t:'hello', name, inCall }                       quem é o PC
 *                 { t:'need', video:bool }                          ligar/desligar a câmera do celular
 */
(function () {
  'use strict';

  const PREFIX = 'wecord-v1-cam-';
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const PAGES_URL = 'https://kaiofanjos.github.io/Wecord/phone.html';

  function newCode(len = 10) {
    const a = new Uint32Array(len);
    crypto.getRandomValues(a);
    return [...a].map((n) => ALPHABET[n % ALPHABET.length]).join('');
  }

  class PhoneLink extends EventTarget {
    /**
     * @param {{ code:string, iceServers:any[], server:any|null, isNative:boolean }} opts
     */
    constructor(opts) {
      super();
      this.opts = opts;
      this.code = opts.code;
      this.peer = null;
      this.conn = null;
      this.call = null;
      this.stream = null;        // MediaStream recebido do celular
      this.caps = { video: false, audio: false };
      this.status = 'off';       // off | waiting | connected | error
      this.closed = false;
      this.retry = 0;
      this.sink = null;          // <audio muted> que "puxa" o áudio remoto (necessário p/ Web Audio no Chromium)
      this.lastNeed = null;
      this.hello = { name: '', inCall: false };
    }

    get url() {
      const base = this.opts.isNative || !/^https?:/.test(location.protocol) || /^(localhost|127\.)/.test(location.hostname)
        ? PAGES_URL
        : new URL('phone.html', location.href).href;
      const q = new URLSearchParams({ c: this.code });
      const s = this.opts.server;
      if (s && s.host) { q.set('sh', s.host); q.set('sp', String(s.port || 443)); q.set('sa', s.path || '/'); }
      const turn = (this.opts.iceServers || []).find((i) => i.username);
      if (turn) {
        q.set('tu', [].concat(turn.urls).join(','));
        q.set('tn', turn.username);
        q.set('tp', turn.credential || '');
      }
      return base + '#' + q.toString();
    }

    get connected() { return this.status === 'connected' && !!this.stream; }
    get videoTrack() { return this.connected && this.caps.video ? this.stream.getVideoTracks()[0] || null : null; }
    get audioTrack() { return this.connected && this.caps.audio ? this.stream.getAudioTracks()[0] || null : null; }

    _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    _setStatus(s) {
      if (this.status === s) return;
      this.status = s;
      this._emit('status', s);
    }

    _peerOptions() {
      const o = { debug: 1, config: { iceServers: this.opts.iceServers } };
      const s = this.opts.server;
      if (s && s.host) {
        o.host = s.host;
        o.port = Number(s.port) || 443;
        o.path = s.path || '/';
        o.secure = s.secure !== false;
      }
      return o;
    }

    start() {
      if (this.closed || this.peer) return;
      this._setStatus(this.connected ? 'connected' : 'waiting');
      const peer = (this.peer = new window.Peer(PREFIX + this.code, this._peerOptions()));
      peer.on('open', () => { this.retry = 0; });
      peer.on('connection', (conn) => this._onConn(conn));
      peer.on('call', (call) => this._onCall(call));
      peer.on('disconnected', () => {
        if (this.closed || peer.destroyed) return;
        setTimeout(() => { if (!this.closed && !peer.destroyed) try { peer.reconnect(); } catch { /* ignore */ } }, 1500);
      });
      peer.on('error', (err) => {
        console.warn('phone peer', err.type, err.message);
        if (this.closed) return;
        // id ainda preso no servidor (PC reiniciado há pouco) ou queda de rede: tenta de novo
        if (['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          this._restartPeer();
        }
      });
    }

    _restartPeer() {
      if (this.closed) return;
      const p = this.peer;
      this.peer = null;
      try { p && p.destroy(); } catch { /* ignore */ }
      const wait = Math.min(15000, 1500 * 2 ** this.retry++);
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.start(), wait);
    }

    _onConn(conn) {
      // só um celular por vez: o mais novo substitui o anterior
      if (this.conn && this.conn !== conn) { try { this.conn.close(); } catch { /* ignore */ } }
      this.conn = conn;
      this.lastNeed = null;
      conn.on('open', () => this.send({ t: 'hello', ...this.hello }));
      conn.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'hello') {
          this.caps = { video: !!m.video, audio: !!m.audio };
          this.facing = m.facing;
          if (this.stream) this._emit('tracks');
        } else if (m.t === 'cam') {
          this._emit('cam', !!m.on);
        }
      });
      conn.on('close', () => { if (this.conn === conn) this._lost(); });
      conn.on('error', () => { if (this.conn === conn) this._lost(); });
    }

    _onCall(call) {
      if (this.call && this.call !== call) { try { this.call.close(); } catch { /* ignore */ } }
      this.call = call;
      call.answer(); // não enviamos mídia para o celular
      call.on('stream', (stream) => {
        if (this.call !== call) return;
        this.stream = stream;
        if (!this.sink) { this.sink = new Audio(); this.sink.muted = true; }
        this.sink.srcObject = stream;
        this.sink.play().catch(() => {});
        this._setStatus('connected');
        this._emit('tracks');
      });
      call.on('close', () => { if (this.call === call) this._lost(); });
      call.on('error', () => { if (this.call === call) this._lost(); });
      // detecta queda (celular bloqueado, Wi-Fi caiu) mesmo sem 'close'
      const pc = call.peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          if (this.call !== call) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._lost();
        });
      }
    }

    _lost() {
      const had = !!this.stream;
      try { this.call && this.call.close(); } catch { /* ignore */ }
      try { this.conn && this.conn.close(); } catch { /* ignore */ }
      this.call = null;
      this.conn = null;
      this.stream = null;
      this.caps = { video: false, audio: false };
      if (this.sink) this.sink.srcObject = null;
      if (this.closed) return;
      this._setStatus('waiting');
      if (had) this._emit('lost');
    }

    send(m) {
      if (this.conn && this.conn.open) { try { this.conn.send(m); } catch { /* ignore */ } }
    }

    setNeed(video) {
      if (this.lastNeed === video) return;
      this.lastNeed = video;
      this.send({ t: 'need', video });
    }

    setHello(h) {
      this.hello = h;
      this.send({ t: 'hello', ...h });
    }

    stop() {
      this.closed = true;
      clearTimeout(this._rt);
      this._lost();
      try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
      this.peer = null;
      this._setStatus('off');
    }
  }

  /** Desenha um QR code como <svg> (sem innerHTML) */
  function qrSvg(text, size = 220) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const margin = 2;
    const total = n + margin * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', total);
    bg.setAttribute('height', total);
    bg.setAttribute('fill', '#fff');
    svg.appendChild(bg);
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.appendChild(path);
    return svg;
  }

  window.WecordPhone = { PhoneLink, newCode, qrSvg };
})();
