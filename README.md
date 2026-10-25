# My iPod (local + installable)

Your music is stored on the device itself (IndexedDB). Nothing is uploaded anywhere.

## Run on your computer
    cd ipod-pwa
    python3 -m http.server 8000
    # open http://localhost:8000

## Use on your phone
Installing/offline needs HTTPS, so host the folder somewhere static
(Netlify Drop, Cloudflare Pages, GitHub Pages), open it on your phone, then
iPhone: Share -> Add to Home Screen.  Android Chrome: menu -> Install app.
Open the installed app and import your music from inside it.

## Importing (all inside the iPod)
Menu -> Settings -> Import
  - Add Songs    pick any number of audio files
  - Add Folder   desktop only; the folder name becomes a playlist
  - Delete Songs pick a song, confirm
  - Delete All   confirm
Desktop: you can also drag & drop files onto the page.
Tags (title/artist/album) are read when present; otherwise "Artist - Title.ext" in the
filename is used. Everything also appears under "All Music" in Playlists.

## What was changed in web-music-ipod_esm.js
Three small, marked patches (search for "PATCH"):
  1. pe(): also look up screens registered in window.__ipodScreens
  2. Settings list: appends rows from window.__ipodSettingsItems()
  3. Menu select handler: new generic "custom" action that calls item.run({back, go})
Everything else (library, import, delete, screens) is in app.js.

## If a song won't play / no progress bar
Open the page as  index.html#debug  (add "#debug" to the address). A small green readout shows:
  ctx: running | suspended   - the audio engine state (should say "running" after your first tap)
  audio: paused / t=seconds  - whether the song clock is moving
  play(): ...                - the browser's error if it refused to start
Also on iPhone: flip the ringer switch to ring (not silent) if you hear nothing.

## Lock screen / Control Center / headphone controls (Media Session)
Title, artist, album and cover art show on the lock screen. Play, pause, next, previous and the
scrubber work from there (and from AirPods / car / Bluetooth buttons). They press the iPod's own
buttons, so its screen stays in sync. Cover art is read from your files' tags; songs without art
show the app icon. Songs imported before this feature get their art filled in automatically in the
background the first time you open the updated app.


## Surround / Atmos (multichannel)
The iPod normally routes every song through Web Audio, which on iOS is stereo-only (surround gets
downmixed). Songs that are multichannel (more than 2 channels) or Dolby (AC-3 / E-AC-3 / AC-4) are
detected from the file header on import and played through a plain <audio> element instead, so the
browser/OS decides how to render them (AirPods spatial audio, AirPlay, etc).
  Settings -> Surround:  Auto (default) | Always (every song) | Off (never)
Trade-offs of the native path: no iPod volume (use the phone's buttons), no fade between songs.
The file must be DRM-free and in a container Safari can play: M4A/MP4 (AAC, ALAC, AC-3, E-AC-3),
FLAC, WAV. Raw .ac3/.ec3 or MKV need converting, e.g.  ffmpeg -i in.mka -c copy out.m4a
