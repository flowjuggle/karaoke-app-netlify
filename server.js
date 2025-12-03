const path = require('path');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sample playlist fallback (so the app runs without a YT API key)
const SAMPLE_PLAYLIST = [
  { videoId: '3JZ_D3ELwOQ', title: 'Californication - Red Hot Chili Peppers' },
  { videoId: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit - Nirvana' },
  { videoId: 'kXYiU_JCYtU', title: 'Numb - Linkin Park' },
  { videoId: 'ktvTqknDobU', title: 'In the End - Linkin Park' }
];

function clampSongTarget(target) {
  const min = 100;
  const max = 800;
  if (Number.isNaN(target)) return min;
  return Math.min(Math.max(target, min), max);
}

function extractPlaylistId(rawValue) {
  if (!rawValue) return '';
  if (rawValue.includes('list=')) {
    const match = rawValue.match(/[?&]list=([^&#]+)/);
    return match ? decodeURIComponent(match[1]) : rawValue.trim();
  }
  return rawValue.trim();
}

// Helper to fetch playlist items, using YouTube Data API if API key exists
async function fetchPlaylistItemsFromYouTube(playlistId, targetCount) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return SAMPLE_PLAYLIST;
  }

  const items = [];
  let pageToken = '';

  while (items.length < targetCount) {
    const url =
      'https://www.googleapis.com/youtube/v3/playlistItems' +
      `?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}` +
      (pageToken ? `&pageToken=${pageToken}` : '') +
      `&key=${apiKey}`;

    const resp = await axios.get(url);
    const mapped = resp.data.items.map((it) => ({
      videoId: it.contentDetails.videoId,
      title: it.snippet.title,
      position: it.snippet.position,
    }));

    items.push(...mapped);

    if (!resp.data.nextPageToken || items.length >= targetCount) {
      break;
    }
    pageToken = resp.data.nextPageToken;
  }

  return items.slice(0, targetCount);
}

// API: GET playlist
app.get('/api/playlist', async (req, res) => {
  try {
    const requestedPlaylist = extractPlaylistId(req.query.playlistId || req.query.playlistUrl || '');
    const targetCount = clampSongTarget(Number(req.query.maxSongs));
    const usingSample = !process.env.YOUTUBE_API_KEY;

    if (!requestedPlaylist) {
      return res.json({ playlistId: 'SAMPLE', items: SAMPLE_PLAYLIST, requested: 0, targetCount: SAMPLE_PLAYLIST.length, fallback: true });
    }

    const items = await fetchPlaylistItemsFromYouTube(requestedPlaylist, targetCount);
    res.json({ playlistId: requestedPlaylist, items, requested: targetCount, count: items.length, fallback: usingSample });
  } catch (err) {
    console.error('Failed to fetch playlist', err.message);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// API: GET song metadata from DB
app.get('/api/song/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  try {
    const row = db.getSong(videoId);
    res.json(row || { videoId, snippetStart: 0, snippetLength: 30, lyrics: '' });
  } catch (err) {
    console.error('db getSong', err.message);
    res.status(500).json({ error: 'Failed to fetch song' });
  }
});

// API: POST save song metadata
app.post('/api/song/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  const { snippetStart, snippetLength, lyrics } = req.body;
  try {
    db.upsertSong({ videoId, snippetStart, snippetLength, lyrics });
    res.json({ ok: true });
  } catch (err) {
    console.error('db upsert', err.message);
    res.status(500).json({ error: 'Failed to save song' });
  }
});

// API: list all saved songs
app.get('/api/songs', (req, res) => {
  try {
    const rows = db.listSongs();
    res.json(rows);
  } catch (err) {
    console.error('db listSongs', err.message);
    res.status(500).json({ error: 'Failed to list songs' });
  }
});

// Serve index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Karaoke app listening on port ${PORT}`);
});
