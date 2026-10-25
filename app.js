/* Local library + Settings > Import menu for <web-music-ipod>.
 *
 * - Songs live in IndexedDB on this device.
 * - The iPod's data request (/includes/ipod/data/...) is answered from that store.
 * - The iPod bundle has three small patches (search "PATCH" in it) that let this file
 *   add a "Import" row to Settings, register extra screens, and run custom menu actions.
 * - After imports/deletes we push fresh data straight into the iPod's data store,
 *   so the menus update live without restarting the element.
 */
(() => {
  'use strict';

  // The element refuses to run when navigator.onLine is false. Everything here is local.
  for (const target of [Navigator.prototype, navigator]) {
    try { Object.defineProperty(target, 'onLine', { get: () => true, configurable: true }); } catch {}
  }

  // ---------- Audio unlock (mobile browsers, esp. iPhone Safari) ----------
  // The iPod routes every song through a Web Audio AudioContext. Mobile browsers keep it
  // "suspended" until resume() is called synchronously inside a real tap/click/key event, and
  // the bundle's own attempts can miss that window (and then throttle themselves for 1s).
  // So we track every AudioContext it creates and resume them directly on each gesture.
  const audioContexts = new Set();
  const mediaEls = new Set();
  let lastPlayError = '';
  let mediaHook = null;            // set by the Media Session section below
  let unlockAudio = () => {};
  let wantPlaying = () => false;   // set below: is a song supposed to be playing right now?
  if (!window.__ipodNoUnlock) {
    const seen = new Set();
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Orig = window[name];
      if (!Orig || seen.has(Orig)) continue;
      seen.add(Orig);
      const Wrapped = function (...args) {
        const c = new Orig(...args);
        audioContexts.add(c);
        // iOS flips the context to "interrupted"/"suspended" on calls, lock, etc. Resume if music should be playing.
        c.addEventListener('statechange', () => {
          if (c.state !== 'running' && c.state !== 'closed' && wantPlaying()) { try { c.resume().catch(() => {}); } catch {} }
        });
        return c;
      };
      Wrapped.prototype = Orig.prototype;
      try { window[name] = Wrapped; } catch {}
    }
    const unlockedCtx = new WeakSet();
    const unlock = () => {
      for (const ctx of audioContexts) {
        if (ctx.state === 'running' || ctx.state === 'closed') continue;
        try { ctx.resume().catch(() => {}); } catch {}
        if (!unlockedCtx.has(ctx)) {          // classic iOS trick: touch the output with a silent buffer
          try {
            const src = ctx.createBufferSource();
            src.buffer = ctx.createBuffer(1, 1, 22050);
            src.connect(ctx.destination); src.start(0);
            unlockedCtx.add(ctx);
          } catch {}
        }
      }
    };
    unlockAudio = unlock;
    for (const ev of ['touchend', 'pointerup', 'mouseup', 'click', 'keydown'])
      window.addEventListener(ev, unlock, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) unlock(); });
    // iOS 17+: ask for "playback" audio so the ringer/silent switch doesn't mute the music.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  // Remember media elements + play() failures (shown by the #debug readout).
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      mediaEls.add(this);
      if (mediaHook) mediaHook(this);
      const p = origPlay.apply(this, a);
      if (p && p.catch) p.catch((e) => { lastPlayError = `${e && e.name}: ${e && e.message}`; });
      return p;
    };
  } catch {}

  // ---------- IndexedDB ----------
  const DB_NAME = 'ipod-library', STORE = 'tracks', ART = 'art';
  let dbPromise;
  function db() {
    return dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(ART)) d.createObjectStore(ART, { keyPath: 'id' });   // {id, blob|null}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn, store = STORE) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  const dbGetAll = () => run('readonly', s => s.getAll());
  const dbPut = (tr) => run('readwrite', s => s.put(tr));
  const dbDelete = (id) => run('readwrite', s => s.delete(id));
  const dbClear = () => run('readwrite', s => s.clear());
  const artGetAll = () => run('readonly', s => s.getAll(), ART);
  const artPut = (id, blob, probe) => run('readwrite', s => s.put({ id, blob, ...(probe ? { channels: probe.channels, codec: probe.codec, probed: true } : {}) }), ART);
  const artDelete = (id) => run('readwrite', s => s.delete(id), ART);
  const artClear = () => run('readwrite', s => s.clear(), ART);

  // ---------- In-memory state ----------
  const state = {
    tracks: [],          // {id, key, name, artistName, albumName, playlist, file, ...}
    loaded: null,        // promise
    probe: new Map(),    // track id -> {channels, codec} read from the file header
    art: new Map(),      // track id -> cover Blob | null (null = checked, none found)
    urls: new Map(),     // track id -> blob: URL (kept stable so a playing song never breaks)
    status: '',          // short text shown on the first Import row while busy / just finished
    busy: false,
  };
  const loadTracks = () => state.loaded ||= Promise.all([dbGetAll(), artGetAll()]).then(([t, a]) => {
    state.tracks = t;
    state.art = new Map(a.map(r => [r.id, r.blob]));
    state.probe = new Map(a.filter(r => r.probed).map(r => [r.id, { channels: r.channels, codec: r.codec }]));
    setTimeout(backfillArt, 1500);          // pick up cover art for songs imported before this feature existed
    return t;
  });

  function urlFor(track) {
    let u = state.urls.get(track.id);
    if (!u) { u = URL.createObjectURL(track.file); state.urls.set(track.id, u); }
    return u;
  }

  // ---------- Build the data the iPod expects ----------
  function makeLibrary() {
    const tracks = [...state.tracks].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const songs = [], byArtist = new Map(), byPlaylist = new Map();
    for (const t of tracks) {
      songs.push({ id: t.id, name: t.name, artistName: t.artistName, albumName: t.albumName, previewUrl: urlFor(t) });
      if (!byArtist.has(t.artistName)) byArtist.set(t.artistName, []);
      byArtist.get(t.artistName).push(t.id);
      if (t.playlist) {
        if (!byPlaylist.has(t.playlist)) byPlaylist.set(t.playlist, []);
        byPlaylist.get(t.playlist).push(t.id);
      }
    }
    const byName = (a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    return {
      songs,
      artists: [...byArtist].sort(byName).map(([name, songIds], i) => ({ id: `artist-${i}`, name, songIds })),
      playlists: [
        { id: 'playlist-all', name: 'All Music', songIds: songs.map(s => s.id) },
        ...[...byPlaylist].sort(byName).map(([name, songIds], i) => ({ id: `playlist-${i}`, name, songIds })),
      ],
    };
  }

  // ---------- fetch shim: answer the iPod's data request from the local library ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/\/includes\/ipod\/data\//.test(url)) {
      return loadTracks().then(() => {
        const lib = makeLibrary();
        updateHint(lib.songs.length);
        return new Response(JSON.stringify({ schemaVersion: 3, language: 'en-US', ...lib }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      });
    }
    return realFetch(input, init);
  };

  // ---------- Push fresh data into the running iPod ----------
  function ipodStore() {
    const el = document.querySelector('web-music-ipod');
    try { return el && el.iPodDataStore; } catch { return null; }
  }
  function pushToIPod() {
    const lib = makeLibrary();
    updateHint(lib.songs.length);
    const store = ipodStore();
    if (store) store.set({ status: 'ready', language: 'en-US', data: { ...lib, importStatus: state.status } });
  }
  let pushTimer = 0;
  function pushSoon() {                       // coalesce rapid updates during big imports
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = 0; pushToIPod(); }, 120);
  }
  function setStatus(text, clearAfterMs) {
    state.status = text;
    pushSoon();
    if (clearAfterMs) setTimeout(() => { if (state.status === text) { state.status = ''; pushSoon(); } }, clearAfterMs);
  }
  function updateHint(count) {
    const h = document.getElementById('hint');
    if (h) h.hidden = count > 0;
  }

  // ---------- Importing ----------
  const AUDIO_TYPES = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', flac: 'audio/flac',
    mp4: 'audio/mp4', m4b: 'audio/mp4',
  };
  const ext = (name) => (name.split('.').pop() || '').toLowerCase();
  const isAudio = (f) => (f.type && f.type.startsWith('audio/')) || ext(f.name) in AUDIO_TYPES;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  function readTags(file) {
    return new Promise((resolve) => {
      if (!window.jsmediatags) return resolve({});
      const timer = setTimeout(() => resolve({}), 4000);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      try {
        window.jsmediatags.read(file, { onSuccess: (r) => done(r.tags || {}), onError: () => done({}) });
      } catch { done({}); }
    });
  }

  // Reads just enough of the file header to learn the codec and channel count.
  const slice = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function* mp4Boxes(buf, dv, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), hdr = 8;
      const type = fourcc(buf, o + 4);
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      yield { type, hdr, start: o, end: o + size };
      o += size;
    }
  }
  async function probeMp4(file) {
    let pos = 0;
    while (pos < file.size) {                       // walk top-level boxes to find moov (often at the end)
      const h = await slice(file, pos, 16);
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0); const type = fourcc(h, 4);
      if (size === 1) size = Number(dv.getBigUint64(8)); else if (size === 0) size = file.size - pos;
      if (size < 8) return null;
      if (type === 'moov') {
        if (size > 16 * 1048576) return null;
        const buf = await slice(file, pos, size), d = new DataView(buf.buffer);
        const kids = (b) => [...mp4Boxes(buf, d, b.start + b.hdr, b.end)];
        const moov = { start: 0, hdr: 8, end: buf.length };
        for (const trak of kids(moov).filter(b => b.type === 'trak')) {
          const mdia = kids(trak).find(b => b.type === 'mdia'); if (!mdia) continue;
          const mk = kids(mdia);
          const hdlr = mk.find(b => b.type === 'hdlr');
          if (!hdlr || fourcc(buf, hdlr.start + hdlr.hdr + 8) !== 'soun') continue;
          const minf = mk.find(b => b.type === 'minf'); if (!minf) continue;
          const stbl = kids(minf).find(b => b.type === 'stbl'); if (!stbl) continue;
          const stsd = kids(stbl).find(b => b.type === 'stsd'); if (!stsd) continue;
          const e = stsd.start + stsd.hdr + 8;       // first sample entry
          return { codec: fourcc(buf, e + 4), channels: d.getUint16(e + 24) };
        }
        return null;
      }
      pos += size;
    }
    return null;
  }
  async function probeAudio(file) {
    const out = { channels: 0, codec: '' };
    try {
      const head = await slice(file, 0, 16);
      if (fourcc(head, 0) === 'fLaC') {
        const si = await slice(file, 0, 32);
        out.codec = 'flac'; out.channels = ((si[20] >> 1) & 7) + 1;
      } else if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WAVE') {
        const buf = await slice(file, 0, 4096), dv = new DataView(buf.buffer);
        for (let o = 12; o + 16 <= buf.length;) {
          const size = dv.getUint32(o + 4, true);
          if (fourcc(buf, o) === 'fmt ') { out.codec = 'pcm'; out.channels = dv.getUint16(o + 10, true); break; }
          o += 8 + size + (size & 1);
        }
      } else if (fourcc(head, 0) === 'OggS') {
        const buf = await slice(file, 0, 512);
        for (let i = 0; i + 10 < buf.length; i++) {
          if (fourcc(buf, i) === 'Opus' && fourcc(buf, i + 4) === 'Head') { out.codec = 'opus'; out.channels = buf[i + 9]; break; }
        }
      } else if (fourcc(head, 4) === 'ftyp') {
        const r = await probeMp4(file);
        if (r) Object.assign(out, r);
      }
    } catch (err) { console.warn('probe failed', err); }
    return out;
  }
  const SURROUND_CODECS = ['ec-3', 'ac-3', 'ac-4'];
  const isSurround = (p) => !!p && (p.channels > 2 || SURROUND_CODECS.includes(p.codec));

  // "Surround" setting: Auto = surround songs bypass Web Audio, Always = every song, Off = never.
  const MODES = ['auto', 'on', 'off'], MODE_LABEL = { auto: 'Auto', on: 'Always', off: 'Off' };
  let surroundMode = 'auto';
  try { const m = localStorage.getItem('ipod-surround'); if (MODES.includes(m)) surroundMode = m; } catch {}
  function cycleSurround() {
    surroundMode = MODES[(MODES.indexOf(surroundMode) + 1) % MODES.length];
    try { localStorage.setItem('ipod-surround', surroundMode); } catch {}
    pushSoon();
  }
  // Called by the iPod bundle for every song it is about to play (PATCH 5).
  window.__ipodUseNativeAudio = (song) => {
    if (surroundMode === 'on') return true;
    if (surroundMode === 'off') return false;
    const url = song && song.previewUrl;
    for (const [id, u] of state.urls) if (u === url) return isSurround(state.probe.get(id));
    return false;
  };

  function artBlob(tags) {
    const p = tags && tags.picture;
    if (!p || !p.data || !p.data.length) return null;
    try { return new Blob([new Uint8Array(p.data)], { type: p.format || 'image/jpeg' }); } catch { return null; }
  }
  let backfilling = false;
  async function backfillArt() {
    if (backfilling) return;
    backfilling = true;
    try {
      for (const t of [...state.tracks]) {
        if (state.probe.has(t.id)) continue;
        const art = artBlob(await readTags(t.file));
        const probe = await probeAudio(t.file);
        if (!state.tracks.includes(t)) continue;          // deleted meanwhile
        state.art.set(t.id, art); state.probe.set(t.id, probe);
        try { await artPut(t.id, art, probe); } catch {}
      }
    } finally { backfilling = false; }
  }

  async function importFiles(fileList, { useFolderAsPlaylist = false } = {}) {
    if (state.busy) return;
    const all = [...fileList];
    const files = all.filter(isAudio);
    if (!files.length) { setStatus(all.length ? 'No audio found' : '', 4000); return; }

    state.busy = true;
    await loadTracks();
    const existing = new Set(state.tracks.map(t => t.key));
    let added = 0, dupes = 0, failed = false;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`Importing ${i + 1}/${files.length}`);
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        if (existing.has(key)) { dupes++; continue; }

        const tags = await readTags(f);
        const base = f.name.replace(/\.[^.]+$/, '');
        let title = tags.title, artist = tags.artist;
        if (!title) {
          const m = base.match(/^(.+?)\s+-\s+(.+)$/);
          if (m && !artist) { artist = m[1].trim(); title = m[2].trim(); } else title = base;
        }
        const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/') : [];
        const playlist = useFolderAsPlaylist && rel.length > 1 ? rel[0] : '';

        // Normalise the MIME type by extension (some browsers report '' or odd types like audio/x-m4a).
        const mime = AUDIO_TYPES[ext(f.name)];
        const file = mime && f.type !== mime ? new Blob([f], { type: mime }) : f;
        const track = {
          id: uid(), key, name: title, artistName: artist || 'Unknown Artist',
          albumName: tags.album || 'Unknown Album', playlist, file, size: f.size, added: Date.now(),
        };
        try {
          const art = artBlob(tags);
          const probe = await probeAudio(f);
          await dbPut(track);
          try { await artPut(track.id, art, probe); } catch {}
          state.art.set(track.id, art); state.probe.set(track.id, probe);
          state.tracks.push(track);
          existing.add(key);
          added++;
        } catch (err) {
          console.error('Could not store', f.name, err);
          failed = true;
          break;
        }
      }
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    } finally {
      state.busy = false;
    }
    if (failed) setStatus('Storage full?', 6000);
    else if (added) setStatus(`Added ${added} song${added === 1 ? '' : 's'}`, 5000);
    else setStatus(dupes ? 'Already added' : '', 4000);
    pushToIPod();
  }

  async function deleteSong(id) {
    await loadTracks();
    await dbDelete(id);
    try { await artDelete(id); } catch {}
    state.art.delete(id); state.probe.delete(id);
    state.tracks = state.tracks.filter(t => t.id !== id);
    // The blob URL is intentionally not revoked: that song may be playing right now.
    pushToIPod();
  }
  async function deleteAll() {
    await dbClear();
    try { await artClear(); } catch {}
    state.art.clear(); state.probe.clear();
    state.tracks = [];
    setStatus('Library cleared', 4000);
    pushToIPod();
  }

  // ---------- Menu: Settings > Import ----------
  const info = (id, title, value) => ({ id, title, action: 'info', ...(value === undefined ? { centered: true } : { value }) });
  const custom = (id, title, runFn) => ({ id, title, action: 'custom', run: runFn });
  const nav = (id, title, target, contextId) => ({ id, title, action: 'navigate', target, contextId });
  const songsOf = (data) => (data && data.songs) || [];
  const canPickFolder = () =>
    matchMedia('(pointer: fine)').matches && 'webkitdirectory' in document.createElement('input');

  window.__ipodSettingsItems = () => [
    nav('import', 'Import', 'import'),
    custom('surround', 'Surround: ' + MODE_LABEL[surroundMode], cycleSurround),
  ];

  window.__ipodScreens = {
    import: {
      view: 'list',
      title: () => 'Import',
      items: ({ data }) => {
        const d = data || {};
        const rows = [
          custom('add-files', d.importStatus || 'Add Songs', () => { if (!state.busy) pickFiles(); }),
        ];
        if (canPickFolder()) rows.push(custom('add-folder', 'Add Folder', () => { if (!state.busy) pickFolder(); }));
        rows.push(
          nav('delete', 'Delete Songs', 'import-delete'),
          nav('delete-all', 'Delete All', 'import-delete-all'),
          info('count', 'Songs on iPod', String(songsOf(d).length)),
        );
        return rows;
      },
    },
    'import-delete': {
      view: 'list',
      title: () => 'Delete Songs',
      items: ({ data }) => {
        const songs = songsOf(data);
        return songs.length
          ? songs.map(s => nav('del-' + s.id, s.name, 'import-delete-confirm', s.id))
          : [info('none', 'No songs')];
      },
    },
    'import-delete-confirm': {
      view: 'list',
      title: ({ data, contextId }) => (songsOf(data).find(s => s.id === contextId) || {}).name || 'Delete?',
      items: ({ data, contextId }) => {
        if (!songsOf(data).some(s => s.id === contextId)) return [info('gone', 'Already deleted')];
        return [
          custom('cancel', 'Cancel', ({ back }) => back()),
          custom('confirm', 'Delete', ({ back }) => { deleteSong(contextId); back(); }),
        ];
      },
    },
    'import-delete-all': {
      view: 'list',
      title: () => 'Delete All',
      forgetsSelection: true,
      items: () => [
        custom('cancel', 'Cancel', ({ back }) => back()),
        custom('confirm', 'Delete All Songs', ({ back }) => { deleteAll(); back(); }),
      ],
    },
  };


  // ---------- Media Session: lock screen / Control Center / headphone buttons ----------
  // Metadata + position come from whichever <audio> element is currently playing. The buttons press
  // the iPod's own on-screen play/pause/next/back buttons, so its screen always stays in sync.
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  let currentEl = null;
  const artUrls = new Map();

  function trackForEl(el) {
    const src = el.currentSrc || el.src;
    for (const [id, url] of state.urls) if (url === src) return state.tracks.find(t => t.id === id);
    return null;
  }
  function artworkFor(track) {
    const blob = track && state.art.get(track.id);
    if (blob) {
      let u = artUrls.get(track.id);
      if (!u) { u = URL.createObjectURL(blob); artUrls.set(track.id, u); }
      return [{ src: u, sizes: '512x512', type: blob.type || 'image/jpeg' }];
    }
    return [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
  }
  function updateMetadata(el) {
    const t = trackForEl(el);
    if (!t) return;
    try {
      ms.metadata = new MediaMetadata({ title: t.name, artist: t.artistName, album: t.albumName, artwork: artworkFor(t) });
    } catch (err) { console.warn('MediaMetadata failed', err); }
  }
  function updatePosition(el) {
    if (!ms || !ms.setPositionState || el !== currentEl) return;
    const d = el.duration;
    if (!isFinite(d) || d <= 0) return;
    try { ms.setPositionState({ duration: d, playbackRate: el.playbackRate || 1, position: Math.min(Math.max(el.currentTime, 0), d) }); } catch {}
  }
  function pressIPod(selector) {
    const host = document.querySelector('web-music-ipod');
    const btn = host && host.shadowRoot && host.shadowRoot.querySelector(selector);
    if (btn) btn.click();
    return !!btn;
  }

  if (ms) {
    wantPlaying = () => !!currentEl && !currentEl.paused && !currentEl.ended;
    const attached = new WeakSet();
    mediaHook = (el) => {
      if (attached.has(el)) return;
      attached.add(el);
      let lastPos = 0;
      el.addEventListener('playing', () => {
        currentEl = el; updateMetadata(el); ms.playbackState = 'playing'; updatePosition(el);
      });
      el.addEventListener('pause', () => { if (el === currentEl) { ms.playbackState = 'paused'; updatePosition(el); } });
      el.addEventListener('ended', () => { if (el === currentEl) ms.playbackState = 'paused'; });
      el.addEventListener('durationchange', () => updatePosition(el));
      el.addEventListener('seeked', () => updatePosition(el));
      el.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastPos > 1000) { lastPos = now; updatePosition(el); }
      });
    };

    const player = () => window.__ipodPlayer;
    const handlers = {
      play:          () => { unlockAudio(); const p = player(); if (p) p.resume(); else if (!currentEl || currentEl.paused) pressIPod('button.playpause-button'); },
      pause:         () => { const p = player(); if (p) p.pause(); else if (currentEl && !currentEl.paused) pressIPod('button.playpause-button'); },
      previoustrack: () => { unlockAudio(); const p = player(); if (p) p.skipPrevious(); else pressIPod('button.back-button'); },
      nexttrack:     () => { unlockAudio(); const p = player(); if (p) p.skipNext(); else pressIPod('button.forward-button'); },
      seekto:        (d) => {
        if (!d || d.seekTime == null) return;
        const p = player();
        if (p) p.seek(d.seekTime); else if (currentEl) currentEl.currentTime = d.seekTime;
        if (currentEl) updatePosition(currentEl);
      },
      // (no seekbackward/seekforward: registering them makes iOS show 10-second buttons instead of previous/next track)
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* action not supported by this browser */ }
    }
  }

  // ---------- Optional debug readout: open the page as  index.html#debug ----------
  function startDebug() {
    const el = document.createElement('pre');
    el.style.cssText = 'position:fixed;left:4px;top:4px;margin:0;padding:4px 6px;font:10px/1.3 monospace;' +
      'color:#9f9;background:rgba(0,0,0,.65);z-index:99;pointer-events:none;max-width:96vw;white-space:pre-wrap';
    document.body.append(el);
    setInterval(() => {
      const ctxs = [...audioContexts].map(c => c.state).join(',') || 'none';
      const a = [...mediaEls].pop();
      let line = 'audio: none yet';
      if (a) line = `audio: paused=${a.paused} t=${a.currentTime.toFixed(1)} dur=${isFinite(a.duration) ? a.duration.toFixed(0) : '?'} ` +
        `ready=${a.readyState} net=${a.networkState} err=${a.error ? a.error.code + ' ' + (a.error.message || '') : '-'}`;
      el.textContent = `ctx: ${ctxs}\n${line}\nplay(): ${lastPlayError || 'ok'}\nUA: ${navigator.userAgent.slice(0, 70)}`;
    }, 400);
  }

  // ---------- File pickers (must be triggered from the menu "select" gesture) ----------
  let fileInput, folderInput;
  function makeInput(attrs, onChange) {
    const el = document.createElement('input');
    el.type = 'file'; el.multiple = true; el.hidden = true;
    Object.assign(el, attrs);
    el.addEventListener('change', () => { const files = [...el.files]; el.value = ''; onChange(files); });
    document.body.append(el);
    return el;
  }
  const pickFiles = () => fileInput.click();
  const pickFolder = () => folderInput.click();

  window.addEventListener('DOMContentLoaded', () => {
    if (/debug/.test(location.hash + location.search)) startDebug();
    fileInput = makeInput({ accept: 'audio/*,.mp3,.m4a,.mp4,.m4b,.aac,.wav,.ogg,.oga,.opus,.flac' },
      (files) => importFiles(files));
    folderInput = makeInput({ webkitdirectory: true },
      (files) => importFiles(files, { useFolderAsPlaylist: true }));

    // Drag & drop (desktop)
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    }
  });
})();
