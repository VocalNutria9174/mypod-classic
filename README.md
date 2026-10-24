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
