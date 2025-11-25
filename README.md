# Karaoke App (local)

A simple karaoke app built with Node.js + Express and a YouTube IFrame frontend. It supports saving snippet metadata in SQLite and works without a YouTube API key using a fallback sample playlist.

## Setup (Windows PowerShell)

1. Install Node (v18+ recommended) and Git: https://nodejs.org

2. Install dependencies and run dev server

```powershell
cd "C:\Users\marti\Documents\Vis Code Flow MK\karaoke-app"
npm install
npm run dev
```

3. Open your browser to http://localhost:3000

## Docker

Build and run the containerized app:

```powershell
# Build
docker build -t karaoke-app .

# Run with env file (create a .env from .env.example if needed)
docker run -p 3000:3000 --env-file .env karaoke-app
```

Or use docker-compose:

```powershell
docker-compose up --build
```

## Environment

- `YOUTUBE_API_KEY` — optional. If present, the server will fetch playlist items using the YouTube Data API. If not, the app uses a small sample playlist.
- `ADMIN_TOKEN` — optional token used for admin endpoints in future.
- `PORT` — optional server port (defaults to 3000).

## Testing

A simple API smoke test is provided in `scripts/test-api.js`. Start the server locally and run:

```powershell
node scripts/test-api.js
```

## Usage

- Load a playlist by ID or leave empty to get the sample playlist.
- Click a song's Play or Edit to load it into the player.
- Set the snippet start and length, then click Preview to play the loop.
- Click Save to store snippet metadata and lyrics in the local SQLite DB (`./data/karaoke.db`).

## Notes

- If you run on Windows and `better-sqlite3` fails to build, use Docker to avoid build problems or install 
  Visual Studio Build Tools first.

Enjoy 🎤

## Netlify (Static) Build

If you'd like a static-only deploy (no server), the `netlify/` folder contains a build that uses localStorage for metadata and works without a backend. To deploy it to Netlify:

1. Run the build step (optional copy helper):
```powershell
npm run build:netlify
```
2. Open https://app.netlify.com/sites/new and use the drag-and-drop deploy option to upload the files inside the `netlify/` folder (not the folder itself).

The static build stores song metadata in localStorage; use the Export/Import buttons to backup or restore user data.