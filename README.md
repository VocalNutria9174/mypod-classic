# My iPod (local + installable)

Your music is stored on the device itself (IndexedDB). Nothing is uploaded anywhere.

## Run on your computer
    cd ipod-pwa
    python3 -m http.server 8000
    # open http://localhost:8000

## Use on your phone
Service workers / "install" need HTTPS (localhost counts as secure), so host the folder
somewhere static and open it on your phone:
  - Netlify Drop (drag the folder onto app.netlify.com/drop), Cloudflare Pages, or GitHub Pages.
Then: iPhone -> Share -> Add to Home Screen. Android Chrome -> menu -> Install app.
Open the installed app, tap "+ Add music", and pick files (from Files / Downloads / iCloud Drive / etc).
(Over plain http on your home Wi-Fi it still works as a normal page, just not installable/offline.)

## Importing
- "+ Add music": pick any number of files. Tags (title/artist/album) are read when present;
  otherwise "Artist - Title.ext" in the filename is used.
- Playlist box: type a name first and everything in that import goes into that playlist.
- "+ Add folder" (desktop only): the folder name becomes the playlist.
- Drag & drop files onto the page on desktop.
- Library panel: remove single songs or everything.

## Files
index.html, app.js (library + import + fetch shim), sw.js (offline cache), manifest.webmanifest,
icons, jsmediatags.min.js (tag reader), web-music-ipod_esm.js (the original element, untouched).
