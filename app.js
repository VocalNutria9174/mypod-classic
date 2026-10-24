/* Local library + import UI for <web-music-ipod>.
 *
 * The iPod element normally fetches /includes/ipod/data/<store>/<lang>.json.
 * We intercept that request and answer it from songs stored in IndexedDB,
 * with each song's previewUrl pointing at a blob: URL for the stored file.
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
  const getAllTracks = () => run('readonly', s => s.getAll());
  const putTrack = (tr) => run('readwrite', s => s.put(tr));
  const deleteTrack = (id) => run('readwrite', s => s.delete(id));
  const clearTracks = () => run('readwrite', s => s.clear());

  // ---------- Build the JSON the iPod expects ----------
  let objectUrls = [];
  function revokeUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }

  async function buildLibrary() {
    revokeUrls();
    const tracks = (await getAllTracks()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const songs = [], byArtist = new Map(), byPlaylist = new Map();
    for (const t of tracks) {
      const url = URL.createObjectURL(t.file);
      objectUrls.push(url);
      songs.push({ id: t.id, name: t.name, artistName: t.artistName, albumName: t.albumName, previewUrl: url });
      if (!byArtist.has(t.artistName)) byArtist.set(t.artistName, []);
      byArtist.get(t.artistName).push(t.id);
      if (t.playlist) {
        if (!byPlaylist.has(t.playlist)) byPlaylist.set(t.playlist, []);
        byPlaylist.get(t.playlist).push(t.id);
      }
    }
    const byName = (a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    return {
      schemaVersion: 3,
      language: 'en-US',
      songs,
      artists: [...byArtist].sort(byName).map(([name, songIds], i) => ({ id: `artist-${i}`, name, songIds })),
      playlists: [
        { id: 'playlist-all', name: 'All Music', songIds: songs.map(s => s.id) },
        ...[...byPlaylist].sort(byName).map(([name, songIds], i) => ({ id: `playlist-${i}`, name, songIds })),
      ],
    };
  }

  // ---------- fetch shim ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/\/includes\/ipod\/data\//.test(url)) {
      return buildLibrary().then(lib => new Response(JSON.stringify(lib), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return realFetch(input, init);
  };

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

  async function importFiles(fileList, playlistOverride) {
    const files = [...fileList].filter(isAudio);
    const skippedType = fileList.length - files.length;
    if (!files.length) return setStatus('No audio files found in that selection.');

    const existing = new Set((await getAllTracks()).map(t => t.key));
    let added = 0, dupes = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`Importing ${i + 1} of ${files.length}: ${f.name}`);
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (existing.has(key)) { dupes++; continue; }

      const tags = await readTags(f);
      const base = f.name.replace(/\.[^.]+$/, '');
      let title = tags.title, artist = tags.artist;
      if (!title) {
        const m = base.match(/^(.+?)\s+-\s+(.+)$/);
        if (m && !artist) { artist = m[1].trim(); title = m[2].trim(); } else title = base;
      }
      // Folder imports: first folder name becomes the playlist, unless the user typed one.
      const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/') : [];
      const playlist = playlistOverride || (rel.length > 1 ? rel[0] : '');

      // Normalise the MIME type by extension (some browsers report '' or odd types like audio/x-m4a).
      const mime = AUDIO_TYPES[ext(f.name)];
      const file = mime && f.type !== mime ? new Blob([f], { type: mime }) : f;
      try {
        await putTrack({
          id: uid(), key, name: title, artistName: artist || 'Unknown Artist',
          albumName: tags.album || 'Unknown Album', playlist, file, size: f.size, added: Date.now(),
        });
        added++;
      } catch (err) {
        console.error('Could not store', f.name, err);
        setStatus(`Stopped: couldn't store "${f.name}" (storage may be full).`);
        break;
      }
    }
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    const bits = [`Added ${added} song${added === 1 ? '' : 's'}`];
    if (dupes) bits.push(`${dupes} already in library`);
    if (skippedType) bits.push(`${skippedType} non-audio file${skippedType === 1 ? '' : 's'} skipped`);
    await refresh();
    setStatus(bits.join(' · ') + '.');
  }

  // ---------- UI ----------
  const $ = (id) => document.getElementById(id);
  function setStatus(msg) { $('status').textContent = msg; }

  function reloadIPod() {
    const old = document.querySelector('web-music-ipod');
    old.replaceWith(document.createElement('web-music-ipod'));   // new element => refetches the library
  }

  async function renderList() {
    const tracks = (await getAllTracks()).sort((a, b) => a.name.localeCompare(b.name));
    $('count').textContent = tracks.length;
    const ul = $('tracks');
    ul.textContent = '';
    for (const t of tracks) {
      const li = document.createElement('li');
      const meta = document.createElement('div'); meta.className = 'meta';
      const title = document.createElement('div'); title.className = 't'; title.textContent = t.name;
      const sub = document.createElement('div'); sub.className = 'a';
      sub.textContent = t.artistName + (t.playlist ? ` · ${t.playlist}` : '');
      meta.append(title, sub);
      const del = document.createElement('button');
      del.type = 'button'; del.title = 'Remove'; del.textContent = '✕';
      del.addEventListener('click', async () => { await deleteTrack(t.id); await refresh(); });
      li.append(meta, del);
      ul.append(li);
    }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        if (usage != null && !$('status').textContent)
          setStatus(`Using ${(usage / 1048576).toFixed(0)} MB of ~${(quota / 1048576).toFixed(0)} MB available.`);
      }
    } catch {}
  }

  async function refresh() { reloadIPod(); await renderList(); }

  window.addEventListener('DOMContentLoaded', () => {
    if (matchMedia('(pointer: fine)').matches) $('folder-btn').hidden = false;

    const onPick = (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      importFiles(files, $('playlist').value.trim());
    };
    $('pick-files').addEventListener('change', onPick);
    $('pick-folder').addEventListener('change', onPick);

    $('clear').addEventListener('click', async () => {
      if (!confirm('Remove all music from this device?')) return;
      await clearTracks(); setStatus('Library cleared.'); await refresh();
    });

    // Drag & drop (desktop)
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files, $('playlist').value.trim());
    });

    renderList();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    }
  });
})();
