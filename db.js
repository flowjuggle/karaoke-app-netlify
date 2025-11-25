const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'karaoke.db');
const db = new Database(DB_PATH);

// Create table if not exists
db.prepare(
  `CREATE TABLE IF NOT EXISTS songs (
    videoId TEXT PRIMARY KEY,
    snippetStart INTEGER DEFAULT 0,
    snippetLength INTEGER DEFAULT 30,
    lyrics TEXT DEFAULT ''
  )`
).run();

function getSong(videoId) {
  const stmt = db.prepare('SELECT * FROM songs WHERE videoId = ?');
  return stmt.get(videoId);
}

function upsertSong({ videoId, snippetStart = 0, snippetLength = 30, lyrics = '' }) {
  const stmt = db.prepare(
    `INSERT INTO songs (videoId, snippetStart, snippetLength, lyrics)
     VALUES (@videoId, @snippetStart, @snippetLength, @lyrics)
     ON CONFLICT(videoId) DO UPDATE SET snippetStart = @snippetStart, snippetLength = @snippetLength, lyrics = @lyrics`
  );
  stmt.run({ videoId, snippetStart, snippetLength, lyrics });
}

function listSongs() {
  const stmt = db.prepare('SELECT * FROM songs');
  return stmt.all();
}

module.exports = { getSong, upsertSong, listSongs };