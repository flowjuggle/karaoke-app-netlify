const axios = require('axios');

async function smoke() {
  const base = process.env.BASE || 'http://localhost:3000';
  try {
    console.log('GET /api/playlist');
    const p = await axios.get(`${base}/api/playlist`);
    console.log('Playlist OK, items:', p.data.items.length);

    const vid = p.data.items[0].videoId;
    console.log('GET /api/song/:videoId', vid);
    const s = await axios.get(`${base}/api/song/${vid}`);
    console.log('Song data', s.data);
  } catch (err) {
    console.error('Smoke test failed', err.message);
    process.exit(2);
  }
}

smoke();
