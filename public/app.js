let ytPlayer;
let currentVideoId = null;
let playlist = [];
let snippetStart = 0;
let snippetLength = 30;
let loopInterval = null;

function byId(id) { return document.getElementById(id) }

// Load playlist items from server
async function loadPlaylist(playlistId) {
  const query = playlistId ? `?playlistId=${encodeURIComponent(playlistId)}` : '';
  const resp = await fetch(`/api/playlist${query}`);
  const json = await resp.json();
  playlist = json.items;
  renderPlaylist();
}

function renderPlaylist() {
  const container = byId('playlistItems');
  container.innerHTML = '';
  playlist.forEach(item => {
    const el = document.createElement('div');
    el.classList.add('song');
    el.innerHTML = `<div class="title">${item.title}</div><div class="actions"><button data-id="${item.videoId}" class="play">Play</button> <button data-id="${item.videoId}" class="edit">Edit</button></div>`;
    container.appendChild(el);
  });
}

// When you click Play on a song
async function playSong(videoId) {
  currentVideoId = videoId;
  snippetStart = Number(byId('snippetStart').value || 0);
  snippetLength = Number(byId('snippetLength').value || 30);
  ytPlayer.loadVideoById(videoId, snippetStart);
}

// Preview snippet with looping
function previewSnippet() {
  if (!currentVideoId) return alert('Pick a song first');
  stopLoop();
  ytPlayer.loadVideoById(currentVideoId, snippetStart);
  loopInterval = setInterval(() => {
    ytPlayer.seekTo(snippetStart);
  }, snippetLength * 1000);
}

function stopLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
}

// Save snippet to server
async function saveSnippet() {
  if (!currentVideoId) return alert('Pick a song first');
  const lyrics = byId('lyrics').value;
  const body = { snippetStart, snippetLength, lyrics };
  const resp = await fetch(`/api/song/${currentVideoId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.ok) alert('Saved');
}

// On load, set up YouTube player and UI
function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('player', {
    height: '360', width: '640', videoId: null,
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange
    }
  });
}

function onPlayerReady(event) {
  console.log('YT player ready');
}

function onPlayerStateChange(event) {
  // if playing after end of snippet, loop
}

// UI wiring
function wireUI() {
  byId('loadPlaylist').addEventListener('click', async () => {
    const pid = byId('playlistId').value.trim();
    await loadPlaylist(pid);
  });

  byId('playlistItems').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const vid = btn.getAttribute('data-id');
    if (btn.classList.contains('play')) {
      // fetch saved snippet and update UI
      const sresp = await fetch(`/api/song/${vid}`);
      const sjson = await sresp.json();
      byId('snippetStart').value = sjson.snippetStart || 0;
      byId('snippetLength').value = sjson.snippetLength || 30;
      byId('lyrics').value = sjson.lyrics || '';
      currentVideoId = vid;
      snippetStart = Number(byId('snippetStart').value);
      snippetLength = Number(byId('snippetLength').value);
      playSong(vid);
    } else if (btn.classList.contains('edit')) {
      // just open for editing (pre-fill)
      const sresp = await fetch(`/api/song/${vid}`);
      const sjson = await sresp.json();
      byId('snippetStart').value = sjson.snippetStart || 0;
      byId('snippetLength').value = sjson.snippetLength || 30;
      byId('lyrics').value = sjson.lyrics || '';
      currentVideoId = vid;
      snippetStart = Number(byId('snippetStart').value);
      snippetLength = Number(byId('snippetLength').value);
    }
  });

  byId('previewSnippet').addEventListener('click', () => {
    snippetStart = Number(byId('snippetStart').value);
    snippetLength = Number(byId('snippetLength').value);
    previewSnippet();
  });

  byId('saveSnippet').addEventListener('click', () => {
    snippetStart = Number(byId('snippetStart').value);
    snippetLength = Number(byId('snippetLength').value);
    saveSnippet();
  });

  // stop loop when video paused or stopped
  setInterval(async () => {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) {
      stopLoop();
    }
  }, 500);
}

// Init on DOM ready
window.addEventListener('DOMContentLoaded', async () => {
  wireUI();
  await loadPlaylist(''); // load sample playlist
});
