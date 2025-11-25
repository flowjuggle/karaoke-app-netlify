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

// Helper to fetch playlist items, using YouTube Data API if API key exists
async function fetchPlaylistItemsFromYouTube(playlistId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return SAMPLE_PLAYLIST;
  }

  // For simplicity, only get first 50 items
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(
    playlistId
  )}&key=${apiKey}`;

  const resp = await axios.get(url);
  return resp.data.items.map((it) => ({
    videoId: it.contentDetails.videoId,
    title: it.snippet.title,
  }));
}

// API: GET playlist
app.get('/api/playlist', async (req, res) => {
  try {
    const playlistId = req.query.playlistId;
    if (!playlistId) {
      // If no playlistId, return sample fallback
      return res.json({ playlistId: 'SAMPLE', items: SAMPLE_PLAYLIST });
    }
    const items = await fetchPlaylistItemsFromYouTube(playlistId);
    res.json({ playlistId, items });
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
