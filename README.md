# Karaoke App

A lightweight karaoke web app paired with a production-ready ingestion, looping, and rights-aware pipeline for building a short-segment karaoke catalog from YouTube.

## Quick start (app)
1. Install Node.js 18+ and Git.
2. Install dependencies and run the server:
   ```bash
   npm install
   npm run dev
   ```
3. Open http://localhost:3000 and load a playlist. Set snippet start/length, preview loops, and save metadata to the local SQLite DB (`./data/karaoke.db`).

### Docker
```bash
# Build
docker build -t karaoke-app .

# Run with env file (create .env from .env.example if needed)
docker run -p 3000:3000 --env-file .env karaoke-app

# Or compose
docker-compose up --build
```

### Environment
- `YOUTUBE_API_KEY` — optional; fetches playlist items via YouTube Data API. Without it, the server uses a fallback sample playlist.
- `ADMIN_TOKEN` — optional admin endpoints token.
- `PORT` — defaults to `3000`.

### Testing
A smoke test exists in `scripts/test-api.js`. Start the server, then run:
```bash
node scripts/test-api.js
```

## Production ingestion + loop pipeline
Use the new Python automation at `scripts/karaoke_pipeline.py` to ingest the playlist `https://www.youtube.com/playlist?list=PL2vNBvHyEXihiuQ2htu6rLcOjw7lzsKcD` into a legally gated, loop-ready catalog.

**What it does**
- Fetches playlist metadata via `yt-dlp` (no YouTube API key required).
- Enforces duration ≥ 40s and a vocal-presence score threshold to reject instrumentals.
- Downloads audio, finds the best 40–60s vocal-rich window (favoring choruses), and computes seamless loop points with crossfade buffers.
- Loudness-normalizes to -14 LUFS and extracts a loop-ready WAV segment.
- Runs Demucs two-stem separation to produce a karaoke bed and isolated vocals; separation quality can be extended with SDR/SIR checks.
- Writes per-track segment metadata (loop offsets, BPM, key, vocal score), rights metadata (distribution blocked until cleared), and upload hooks for storage.

**Install dependencies (Python 3.10+)**
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements-karaoke.txt
```

**Run the pipeline**
```bash
python scripts/karaoke_pipeline.py \
  --playlist https://www.youtube.com/playlist?list=PL2vNBvHyEXihiuQ2htu6rLcOjw7lzsKcD \
  --workdir output \
  --limit 25 \
  --score-threshold 0.2
```
Outputs (all inside `output/`):
- `raw/` — downloaded WAVs.
- `segments/` — loop-ready, normalized 40–60s clips.
- `separation/` — Demucs stems (`vocals.wav`, `no_vocals.wav`).
- `metadata/` — segment metadata JSON, rights metadata JSON, QA targets.

**Rights & compliance**
- Distribution is blocked until a license state is marked cleared in `*_rights.json`.
- Each track records provenance (YouTube ID, uploader, license string) and the reason for any rejection (duration, vocal score, pending clearance).
- Intended catalog size is 100–800 tracks (200 default target) after manual clearance; do **not** distribute audio until rights are cleared.

**Adaptive lyric sync**
- Pair forced alignment (MFA/Gentle) with beat tracking (`librosa.beat.beat_track`) and store timestamps alongside tempo maps.
- Runtime warp should adjust timestamps for ±10% tempo and ±2 semitone pitch shifts, keeping ≤100 ms sync error during looping.

## Architecture
A detailed architecture, service breakdown, QA gates, and milestone alignment are documented in `docs/ARCHITECTURE.md` (includes a Mermaid diagram). The flow covers ingestion, rights management, audio processing/separation, lyric alignment, storage/CDN, and client playback across web and mobile.

## Netlify static build
The `netlify/` folder contains a static-only build that stores metadata in `localStorage`. Deploy by running `npm run build:netlify` and uploading the folder’s contents to Netlify.
