# Karaoke App (Netlify Static)

This is a static-only build of the Karaoke App that stores metadata in your browser's localStorage and requires no server.

What is included:
- `index.html` — static UI configured to use localStorage
- `app.netlify.js` — front-end app that uses localStorage for snippet metadata
- `styles.css` — styles
- `netlify.toml` — Netlify config

How to deploy to Netlify (drag & drop)
1. Open https://app.netlify.com/sites/new
2. Choose "Deploy manually" -> "Deploy a site without connecting to Git" -> drag & drop the entire contents of this `netlify/` folder (not the folder itself, the files inside)
3. Wait for the deploy to finish and open the site; the app will be available as a static site.

How to use (static):
- Load the sample playlist, click Play on a song, edit snippet start / length and lyrics.
- Use the "Save (local)" button to persist snippet/lyrics to localStorage.
- Use Export to download saved data as JSON and Import to upload a saved JSON.

Notes and limitations:
- This static version does not save metadata to a server. If you need per-user or shared persistence, host the full server (see project README) on a remote host or Vercel/Heroku and update the front-end API urls.
- This static build does not use the YouTube Data API; it uses an embedded sample playlist.

Troubleshooting:
- If the YouTube player does not load, confirm the browser is allowed to load https://www.youtube.com/iframe_api
- If import/export fails, check the browser console

Enjoy 🎤
