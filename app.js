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

  // ---------- IndexedDB ----------
  const DB_NAME = 'ipod-library', STORE = 'tracks';
  let dbPromise;
  function db() {
    return dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  const dbGetAll = () => run('readonly', s => s.getAll());
  const dbPut = (tr) => run('readwrite', s => s.put(tr));
  const dbDelete = (id) => run('readwrite', s => s.delete(id));
  const dbClear = () => run('readwrite', s => s.clear());

  // ---------- In-memory state ----------
  const state = {
    tracks: [],          // {id, key, name, artistName, albumName, playlist, file, ...}
    loaded: null,        // promise
    urls: new Map(),     // track id -> blob: URL (kept stable so a playing song never breaks)
    status: '',          // short text shown on the first Import row while busy / just finished
    busy: false,
  };
  const loadTracks = () => state.loaded ||= dbGetAll().then(t => (state.tracks = t));

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
          await dbPut(track);
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
    state.tracks = state.tracks.filter(t => t.id !== id);
    // The blob URL is intentionally not revoked: that song may be playing right now.
    pushToIPod();
  }
  async function deleteAll() {
    await dbClear();
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

  window.__ipodSettingsItems = () => [nav('import', 'Import', 'import')];

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
    fileInput = makeInput({ accept: 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac' },
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
