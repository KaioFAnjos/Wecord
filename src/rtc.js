/*
 * Wecord — camada de rede
 *
 * - Sinalização: servidor público PeerJS (gratuito) ou um servidor próprio.
 * - Cada pessoa tem um ID aleatório. A "sala" é um segundo ID (wecord-v1-room-CODIGO)
 *   mantido por alguém da sala: quem entra pergunta a esse "lobby" a lista de pessoas
 *   e conecta diretamente em todas (malha P2P).
 * - Se quem mantém o lobby sair, o próximo da sala assume automaticamente.
 * - Mídia: um RTCPeerConnection por pessoa com "perfect negotiation", permitindo
 *   ligar/desligar câmera e tela a qualquer momento.
 */
(function () {
  'use strict';

  const PREFIX = 'wecord-v1-';
  const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ID_ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const NET_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'];

  const QUALITY = {
    '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, label: '720p · 30 fps' },
    '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4_500_000, label: '1080p · 30 fps' },
    '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, label: '1080p · 60 fps' },
    '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 12_000_000, label: '1440p · 60 fps' },
  };
  const CHUNK = 4000; // caracteres por pedaço (o PeerJS limita cada mensagem a ~16 KB já codificada)
  const MAX_DIRECT = 14000; // bytes
  const textEncoder = new TextEncoder();
  const CAM_ENCODING = { maxBitrate: 1_500_000, maxFramerate: 30 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function rand(n, alpha) {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => alpha[x % alpha.length]).join('');
  }
  function normalizeCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }
  function formatCode(c) {
    return c && c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c || '';
  }
  function friendly(message, type) {
    const e = new Error(message);
    e.friendly = true;
    e.type = type;
    return e;
  }

  // Opus em estéreo e com bitrate alto: deixa o áudio do computador (músicas, filmes) bonito
  function tuneOpus(sdp) {
    const pts = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
    for (const pt of pts) {
      sdp = sdp.replace(new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)', 'g'), (line, params) => {
        let p = params;
        if (!/stereo=/.test(p)) p += ';stereo=1';
        if (!/sprop-stereo=/.test(p)) p += ';sprop-stereo=1';
        if (!/maxaveragebitrate=/.test(p)) p += ';maxaveragebitrate=128000';
        return 'a=fmtp:' + pt + ' ' + p;
      });
    }
    return sdp;
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
    emit(e, ...a) {
      for (const f of this._h[e] || []) {
        try { f(...a); } catch (err) { console.error('[wecord] handler', e, err); }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Link: conexão com UMA outra pessoa                                  */
  /* ------------------------------------------------------------------ */
  class Link {
    constructor(room, conn, retriesLeft = 0) {
      this.room = room;
      this.conn = conn;
      this.id = conn.peer;
      this.polite = room.peer.id > this.id;
      this.retriesLeft = retriesLeft;
      this.open = false;
      this.closed = false;
      this.announced = false;
      this.name = 'Convidado';
      this.state = {};
      this.kinds = {};
      this.isLobby = false;
      this.outbox = [];
      this.chunkSeq = 0;
      this.parts = new Map();
      this.queue = Promise.resolve();
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.own = new Set(); // transceivers criados por nós
      this.senders = new Map(); // trackId -> transceiver
      this.pc = null;
      this.problemAt = null;

      conn.on('open', () => this._onOpen());
      conn.on('data', (m) => this._onData(m));
      conn.on('close', () => this.destroy('close'));
      conn.on('error', (e) => console.warn('[wecord] conexão', this.id, e && e.type, e));
      this.openTimer = setTimeout(() => { if (!this.open) this.destroy('timeout'); }, 25000);
      if (conn.open) queueMicrotask(() => this._onOpen());
    }

    send(m) {
      if (this.closed) return;
      if (!this.open) { this.outbox.push(m); return; }
      try {
        // O canal JSON do PeerJS não aceita mensagens grandes (SDP com várias trilhas):
        // mensagens grandes vão em pedaços e são remontadas do outro lado.
        const json = JSON.stringify(m);
        if (textEncoder.encode(json).length <= MAX_DIRECT) { this.conn.send(m); return; }
        const id = ++this.chunkSeq;
        const n = Math.ceil(json.length / CHUNK);
        for (let i = 0; i < n; i++) this.conn.send({ t: 'part', id, i, n, d: json.slice(i * CHUNK, (i + 1) * CHUNK) });
      } catch (e) { console.warn('[wecord] send', e); }
    }

    _onOpen() {
      if (this.open || this.closed) return;
      clearTimeout(this.openTimer);
      this.open = true;
      const r = this.room;
      this.send({ t: 'hello', v: 1, name: r.name, state: r.state, kinds: r.streamKinds, lobby: !!r.lobby });
      const box = this.outbox;
      this.outbox = [];
      box.forEach((m) => this.send(m));
      if (!this.pc) this._createPC();
      for (const entry of r.localTracks.values()) this.addLocal(entry);
    }

    _createPC() {
      const pc = (this.pc = new RTCPeerConnection({ iceServers: this.room.opts.iceServers, bundlePolicy: 'max-bundle' }));
      pc.onnegotiationneeded = async () => {
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          this.send({ t: 'sdp', d: pc.localDescription.toJSON() });
        } catch (e) {
          console.warn('[wecord] negociação', e);
        } finally {
          this.makingOffer = false;
        }
      };
      pc.onicecandidate = (e) => { if (e.candidate) this.send({ t: 'ice', c: e.candidate.toJSON() }); };
      pc.ontrack = (e) => this._onTrack(e);
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        this.room.emit('peer-conn', this.id, s);
        if (s === 'connected') {
          this.problemAt = null;
          clearTimeout(this.failTimer);
          this.failTimer = null;
        } else if (s === 'failed') {
          try { pc.restartIce(); } catch { /* ignore */ }
          this._armFail();
        } else if (s === 'disconnected') {
          this._armFail();
        }
      };
    }

    _armFail() {
      if (!this.problemAt) this.problemAt = Date.now();
      clearTimeout(this.failTimer);
      this.failTimer = setTimeout(() => {
        this.failTimer = null;
        if (this.closed || !this.pc || this.pc.connectionState === 'connected') return;
        if (Date.now() - this.problemAt > 40000) { this.destroy('lost'); return; }
        try { this.pc.restartIce(); } catch { /* ignore */ }
        this._armFail();
      }, 6000);
    }

    _onData(m) {
      if (!m || typeof m !== 'object' || this.closed) return;
      const r = this.room;
      switch (m.t) {
        case 'part': {
          if (typeof m.d !== 'string' || !(m.n > 0) || m.n > 500) return;
          let buf = this.parts.get(m.id);
          if (!buf) { buf = { n: m.n, got: 0, d: [] }; this.parts.set(m.id, buf); }
          if (buf.d[m.i] === undefined) { buf.d[m.i] = m.d; buf.got++; }
          if (buf.got === buf.n) {
            this.parts.delete(m.id);
            let full;
            try { full = JSON.parse(buf.d.join('')); } catch { return; }
            if (full && full.t !== 'part') this._onData(full);
          }
          break;
        }
        case 'sdp':
        case 'ice':
          this.queue = this.queue.then(() => this._signal(m)).catch((e) => console.warn('[wecord] sinal', e));
          break;
        case 'hello':
          this.name = String(m.name || 'Convidado').slice(0, 32);
          this.state = m.state || {};
          this.kinds = m.kinds || {};
          this.isLobby = !!m.lobby;
          if (!this.announced) {
            this.announced = true;
            r.emit('peer-join', this.id, this.name, this.state);
          } else {
            r.emit('peer-state', this.id, this.state, this.name);
          }
          break;
        case 'state':
          this.state = m.state || {};
          if (m.name) this.name = String(m.name).slice(0, 32);
          r.emit('peer-state', this.id, this.state, this.name);
          break;
        case 'kinds':
          this.kinds = m.kinds || {};
          break;
        case 'chat':
          r.emit('chat', this.id, this.name, String(m.text || '').slice(0, 2000), m.ts || Date.now());
          break;
        case 'lobby-holder':
          this.isLobby = true;
          break;
        case 'bye':
          this.destroy('bye');
          break;
        default:
          break;
      }
    }

    async _signal(m) {
      if (this.closed) return;
      if (!this.pc) this._createPC();
      const pc = this.pc;
      if (m.t === 'sdp' && m.d) {
        const d = { type: m.d.type, sdp: tuneOpus(m.d.sdp || '') };
        const collision = d.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ t: 'sdp', d: pc.localDescription.toJSON() });
        }
      } else if (m.t === 'ice' && m.c) {
        try {
          await pc.addIceCandidate(m.c);
        } catch (e) {
          if (!this.ignoreOffer) console.warn('[wecord] ice', e);
        }
      }
    }

    _onTrack(e) {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const kind = this.kinds[stream.id] || 'main';
      const r = this.room;
      if (!stream.__wecord) {
        stream.__wecord = true;
        const again = () => { if (!this.closed) r.emit('peer-track', this.id, this.kinds[stream.id] || kind, stream); };
        stream.addEventListener('removetrack', again);
        stream.addEventListener('addtrack', again);
      }
      r.emit('peer-track', this.id, kind, stream);
    }

    _inUse(tr) {
      for (const t of this.senders.values()) if (t === tr) return true;
      return false;
    }

    async addLocal({ track, stream, kind }) {
      if (!this.pc || this.closed || this.senders.has(track.id)) return;
      const enc = this.room.encodingFor(kind, track);
      let tr = null;
      for (const t of this.own) {
        if (!this._inUse(t) && t.receiver.track.kind === track.kind && t.currentDirection !== 'stopped') { tr = t; break; }
      }
      try {
        if (tr) {
          this.senders.set(track.id, tr);
          tr.direction = 'sendonly';
          await tr.sender.replaceTrack(track);
          tr.sender.setStreams(stream);
          if (enc) await this._setParams(tr.sender, enc);
        } else {
          const init = { direction: 'sendonly', streams: [stream] };
          if (enc) init.sendEncodings = [enc];
          tr = this.pc.addTransceiver(track, init);
          this.own.add(tr);
          this.senders.set(track.id, tr);
        }
      } catch (e) {
        console.warn('[wecord] addLocal', e);
      }
    }

    removeLocal(trackId) {
      const tr = this.senders.get(trackId);
      if (!tr) return;
      this.senders.delete(trackId);
      try { this.pc.removeTrack(tr.sender); } catch (e) { console.warn('[wecord] removeLocal', e); }
    }

    replaceLocal(oldId, newTrack) {
      const tr = this.senders.get(oldId);
      if (!tr) return;
      this.senders.delete(oldId);
      this.senders.set(newTrack.id, tr);
      tr.sender.replaceTrack(newTrack).catch((e) => console.warn('[wecord] replaceTrack', e));
    }

    async _setParams(sender, enc) {
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) return;
        Object.assign(p.encodings[0], enc);
        await sender.setParameters(p);
      } catch (e) {
        console.warn('[wecord] setParameters', e);
      }
    }

    destroy(reason, silent) {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.openTimer);
      clearTimeout(this.failTimer);
      try { this.pc && this.pc.close(); } catch { /* ignore */ }
      try { this.conn.close(); } catch { /* ignore */ }
      const r = this.room;
      if (r.links.get(this.id) === this) r.links.delete(this.id);
      if (this.announced && !silent) r.emit('peer-leave', this.id, this.name, reason);

      // Queda inesperada: o lado com ID menor tenta reconectar sozinho
      if (!silent && reason !== 'bye' && reason !== 'leave' && !r.closed && r.peer && r.peer.id < this.id) {
        const left = this.announced ? 8 : this.retriesLeft;
        if (left > 0) setTimeout(() => r.connectTo(this.id, left - 1), 3000);
      }
      if (!r.closed) setTimeout(() => r._lobbyLost(), 500);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Room                                                                */
  /* ------------------------------------------------------------------ */
  class Room extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.name = opts.name || 'Convidado';
      this.links = new Map();
      this.localTracks = new Map(); // trackId -> { track, stream, kind }
      this.streamKinds = {}; // streamId -> 'main' | 'screen'
      this.state = { mic: true, cam: false, screen: false, deaf: false };
      this.screenQuality = QUALITY['1080p30'];
      this.peer = null;
      this.lobby = null;
      this.code = null;
      this.closed = false;
      this.claiming = false;
    }

    get myId() { return this.peer ? this.peer.id : null; }

    _peerOptions() {
      const o = { debug: 1, config: { iceServers: this.opts.iceServers } };
      const s = this.opts.server;
      if (s && s.host) {
        o.host = s.host;
        o.port = Number(s.port) || 443;
        o.path = s.path || '/';
        o.secure = s.secure !== false;
        if (s.key) o.key = s.key;
      }
      return o;
    }

    _open(id) {
      return new Promise((resolve, reject) => {
        let p;
        try {
          p = new Peer(id, this._peerOptions());
        } catch (e) {
          reject(e);
          return;
        }
        const cleanup = () => { clearTimeout(timer); p.off('open', onOpen); p.off('error', onErr); };
        const onOpen = () => { cleanup(); resolve(p); };
        const onErr = (err) => { cleanup(); try { p.destroy(); } catch { /* ignore */ } reject(err); };
        const timer = setTimeout(() => {
          cleanup();
          try { p.destroy(); } catch { /* ignore */ }
          reject(friendly('Não consegui falar com o servidor de conexão. Verifique sua internet.', 'timeout'));
        }, 15000);
        p.on('open', onOpen);
        p.on('error', onErr);
      });
    }

    async create() {
      this.peer = await this._open(PREFIX + rand(14, ID_ALPHA));
      this._wirePeer();
      for (let i = 0; i < 6 && !this.code; i++) {
        const code = rand(6, CODE_ALPHA);
        try {
          this.lobby = await this._open(PREFIX + 'room-' + code);
          this.code = code;
        } catch (e) {
          if (e.type !== 'unavailable-id') throw e;
        }
      }
      if (!this.code) throw friendly('Não foi possível criar a sala. Tente de novo.');
      this._wireLobby();
      return this.code;
    }

    async join(raw) {
      const code = normalizeCode(raw);
      if (code.length !== 6) throw friendly('O código da sala tem 6 caracteres (ex: ABC-123).');
      this.peer = await this._open(PREFIX + rand(14, ID_ALPHA));
      this._wirePeer();
      const ids = await this._askLobby(code);
      this.code = code;
      ids.filter((id) => id && id !== this.peer.id).forEach((id) => this.connectTo(id));
      return code;
    }

    _askLobby(code) {
      return new Promise((resolve, reject) => {
        const target = PREFIX + 'room-' + code;
        let conn;
        const cleanup = () => { clearTimeout(timer); this.peer.off('error', onErr); };
        const fail = (msg) => { cleanup(); try { conn && conn.close(); } catch { /* ignore */ } reject(friendly(msg)); };
        const onErr = (err) => {
          if (err && err.type === 'peer-unavailable' && String(err.message || '').includes(target)) {
            fail('Sala não encontrada. Confira o código — quem criou a sala precisa estar com o Wecord aberto.');
          }
        };
        const timer = setTimeout(() => fail('A sala não respondeu. Tente novamente em alguns segundos.'), 20000);
        this.peer.on('error', onErr);
        conn = this.peer.connect(target, { reliable: true, serialization: 'json' });
        conn.on('data', (m) => {
          if (m && m.t === 'lobby' && Array.isArray(m.ids)) {
            cleanup();
            resolve(m.ids.map(String));
            setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 800);
          }
        });
        conn.on('error', (e) => console.warn('[wecord] lobby conn', e));
      });
    }

    _wirePeer() {
      const p = this.peer;
      p.on('connection', (conn) => this._attach(conn));
      p.on('disconnected', () => this._reconnectSignal(p));
      p.on('open', () => this.emit('signal', 'online'));
      p.on('error', (err) => {
        if (!err || err.type === 'peer-unavailable') return;
        if (NET_ERRORS.includes(err.type)) { this._reconnectSignal(p); return; }
        console.warn('[wecord] peer', err.type, err);
      });
    }

    _wireLobby() {
      const l = this.lobby;
      l.on('connection', (conn) => {
        conn.on('open', () => {
          const ids = [this.peer.id, ...[...this.links.values()].filter((k) => k.open).map((k) => k.id)];
          try { conn.send({ t: 'lobby', ids }); } catch { /* ignore */ }
          setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 4000);
        });
        conn.on('error', () => {});
      });
      l.on('disconnected', () => this._reconnectSignal(l));
      l.on('error', (err) => { if (err && NET_ERRORS.includes(err.type)) this._reconnectSignal(l); });
      this.broadcast({ t: 'lobby-holder' });
    }

    _reconnectSignal(p) {
      if (this.closed || !p || p.destroyed || p.__retry) return;
      if (p === this.peer) this.emit('signal', 'offline');
      let delay = 1000;
      const tick = () => {
        p.__retry = null;
        if (this.closed || p.destroyed || !p.disconnected) return;
        try { p.reconnect(); } catch { /* ignore */ }
        delay = Math.min(delay * 2, 15000);
        p.__retry = setTimeout(tick, delay);
      };
      p.__retry = setTimeout(tick, delay);
    }

    _lobbyLost() {
      if (this.closed || this.lobby || this.claiming || !this.code || !this.peer) return;
      const links = [...this.links.values()];
      if (links.some((l) => l.isLobby && !l.closed)) return;
      const ids = [this.peer.id, ...links.filter((l) => l.open).map((l) => l.id)].sort();
      if (ids[0] !== this.peer.id) return;
      this._claimLobby();
    }

    async _claimLobby() {
      this.claiming = true;
      for (let i = 0; i < 40 && !this.closed && !this.lobby; i++) {
        if ([...this.links.values()].some((l) => l.isLobby && !l.closed)) break;
        try {
          const l = await this._open(PREFIX + 'room-' + this.code);
          if (this.closed) { l.destroy(); break; }
          this.lobby = l;
          this._wireLobby();
          break;
        } catch {
          await sleep(5000);
        }
      }
      this.claiming = false;
    }

    connectTo(id, retriesLeft = 0) {
      if (this.closed || !this.peer || id === this.peer.id) return;
      const ex = this.links.get(id);
      if (ex && !ex.closed) return;
      const conn = this.peer.connect(id, { reliable: true, serialization: 'json' });
      this._attach(conn, retriesLeft);
    }

    _attach(conn, retriesLeft = 0) {
      if (this.closed) { try { conn.close(); } catch { /* ignore */ } return; }
      const old = this.links.get(conn.peer);
      let wasAnnounced = false;
      if (old && !old.closed) {
        wasAnnounced = old.announced;
        old.destroy('replaced', true);
      }
      const link = new Link(this, conn, retriesLeft);
      if (wasAnnounced) link.announced = true;
      this.links.set(conn.peer, link);
    }

    encodingFor(kind, track) {
      if (track.kind !== 'video') return null;
      if (kind === 'screen') {
        return { maxBitrate: this.screenQuality.bitrate, maxFramerate: this.screenQuality.fps, priority: 'high', networkPriority: 'high' };
      }
      return { ...CAM_ENCODING };
    }

    addTrack(track, stream, kind) {
      const entry = { track, stream, kind };
      this.localTracks.set(track.id, entry);
      if (this.streamKinds[stream.id] !== kind) {
        this.streamKinds[stream.id] = kind;
        this.broadcast({ t: 'kinds', kinds: this.streamKinds });
      }
      for (const l of this.links.values()) if (l.open) l.addLocal(entry);
    }

    removeTrack(track) {
      if (!this.localTracks.delete(track.id)) return;
      for (const l of this.links.values()) l.removeLocal(track.id);
    }

    replaceTrack(oldTrack, newTrack) {
      const e = this.localTracks.get(oldTrack.id);
      if (!e) return;
      this.localTracks.delete(oldTrack.id);
      this.localTracks.set(newTrack.id, { ...e, track: newTrack });
      for (const l of this.links.values()) l.replaceLocal(oldTrack.id, newTrack);
    }

    setState(partial) {
      Object.assign(this.state, partial);
      this.broadcast({ t: 'state', state: this.state, name: this.name });
    }

    setName(name) {
      this.name = name;
      this.broadcast({ t: 'state', state: this.state, name });
    }

    sendChat(text) {
      this.broadcast({ t: 'chat', text, ts: Date.now() });
    }

    broadcast(m) {
      for (const l of this.links.values()) if (l.open) l.send(m);
    }

    peerConnection(id) {
      const l = this.links.get(id);
      return l ? l.pc : null;
    }

    async leave() {
      if (this.closed) return;
      this.broadcast({ t: 'bye' });
      this.closed = true;
      await sleep(200);
      for (const l of [...this.links.values()]) l.destroy('leave', true);
      this.links.clear();
      try { this.lobby && this.lobby.destroy(); } catch { /* ignore */ }
      try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    }
  }

  window.Wecord = { Room, QUALITY, normalizeCode, formatCode };
})();
