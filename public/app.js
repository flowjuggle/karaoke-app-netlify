let ytPlayer;
let currentVideoId = null;
let playlist = [];
let snippetStart = 0;
let snippetLength = 30;
let loopInterval = null;
let loopActive = false;
let loopMode = 'snippet';

function byId(id) { return document.getElementById(id) }

// Load playlist items from server
async function loadPlaylist(playlistId) {
  const maxSongs = Number(byId('maxSongs').value) || 100;
  const params = new URLSearchParams();
  if (playlistId) params.append('playlistId', playlistId);
  params.append('maxSongs', maxSongs);

  const resp = await fetch(`/api/playlist?${params.toString()}`);
  const json = await resp.json();
  playlist = json.items;
  renderPlaylist();
  const status = byId('playlistStatus');
  if (json.error) {
    status.textContent = 'Failed to load playlist';
  } else {
    const totalTarget = json.requested || playlist.length;
    status.textContent = `Loaded ${playlist.length}/${totalTarget} songs from ${json.playlistId}`;
    if (json.fallback) {
      status.textContent += ' (using offline-safe sample until a YouTube API key is set).';
    }
  }
}

function renderPlaylist() {
  const container = byId('playlistItems');
  container.innerHTML = '';
  byId('playlistCount').textContent = playlist.length;
  playlist.forEach(item => {
    const el = document.createElement('div');
    el.classList.add('song');
    const label = item.position !== undefined ? `#${item.position + 1} · ` : '';
    el.innerHTML = `<div class="title">${label}${item.title}</div><div class="actions"><button data-id="${item.videoId}" class="play">Play</button> <button data-id="${item.videoId}" class="edit">Edit</button></div>`;
    container.appendChild(el);
  });
}

// When you click Play on a song
async function playSong(videoId) {
  currentVideoId = videoId;
  stopLoop();
  snippetStart = Number(byId('snippetStart').value || 0);
  snippetLength = Number(byId('snippetLength').value || 30);
  ytPlayer.loadVideoById(videoId, snippetStart);
}

// Preview snippet with looping
function previewSnippet() {
  if (!currentVideoId) return alert('Pick a song first');
  loopMode = byId('loopMode').value;
  startLoop();
}

function stopLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  loopActive = false;
}

function startLoop() {
  stopLoop();
  loopActive = true;
  if (loopMode === 'full') {
    ytPlayer.loadVideoById(currentVideoId, 0);
    return;
  }

  ytPlayer.loadVideoById(currentVideoId, snippetStart);
  loopInterval = setInterval(() => {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    const currentTime = ytPlayer.getCurrentTime();
    if (currentTime >= snippetStart + snippetLength) {
      ytPlayer.seekTo(snippetStart, true);
      ytPlayer.playVideo();
    }
  }, 300);
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
  if (!loopActive || !ytPlayer) return;
  if (event.data === YT.PlayerState.ENDED) {
    if (loopMode === 'full') {
      ytPlayer.seekTo(0, true);
      ytPlayer.playVideo();
    } else {
      ytPlayer.seekTo(snippetStart, true);
      ytPlayer.playVideo();
    }
  }
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

  byId('stopLoop').addEventListener('click', () => {
    stopLoop();
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
      if (!loopActive) {
        stopLoop();
      }
    }
  }, 500);
}

// Init on DOM ready
window.addEventListener('DOMContentLoaded', async () => {
  wireUI();
  await loadPlaylist(byId('playlistId').value.trim());
});
