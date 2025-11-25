// Static-only Karaoke app (Netlify)
let ytPlayer;
let currentVideoId = null;
let playlist = [];
let snippetStart = 0;
let snippetLength = 30;
let loopInterval = null;

const SAMPLE_PLAYLIST = [
  { videoId: '3JZ_D3ELwOQ', title: 'Californication - Red Hot Chili Peppers' },
  { videoId: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit - Nirvana' },
  { videoId: 'kXYiU_JCYtU', title: 'Numb - Linkin Park' },
  { videoId: 'ktvTqknDobU', title: 'In the End - Linkin Park' }
];

function byId(id){return document.getElementById(id)}

// Local-storage helpers
function getSaved(key){
  try{ return JSON.parse(localStorage.getItem(key)); }catch(e){ return null; }
}
function setSaved(key,val){ localStorage.setItem(key, JSON.stringify(val)); }

// Save snippet metadata to localStorage under 'karaoke:saved'
function localSaveSong(song){
  const map = getSaved('karaoke:saved') || {};
  map[song.videoId] = song;
  setSaved('karaoke:saved', map);
}
function localGetSong(videoId){
  const map = getSaved('karaoke:saved') || {};
  return map[videoId] || null;
}
function localListSongs(){
  const map = getSaved('karaoke:saved') || {};
  return Object.values(map);
}

async function loadPlaylist(playlistId){
  // static mode: always load sample playlist
  playlist = SAMPLE_PLAYLIST;
  renderPlaylist();
}

function renderPlaylist(){
  const container = byId('playlistItems');
  container.innerHTML='';
  playlist.forEach(item => {
    const el = document.createElement('div');
    el.classList.add('song');
    el.innerHTML = `<div class="title">${item.title}</div><div class="actions"><button data-id="${item.videoId}" class="play">Play</button> <button data-id="${item.videoId}" class="edit">Edit</button></div>`;
    container.appendChild(el);
  });
}

function playSong(videoId){
  currentVideoId = videoId;
  snippetStart = Number(byId('snippetStart').value || 0);
  snippetLength = Number(byId('snippetLength').value || 30);
  ytPlayer.loadVideoById(videoId, snippetStart);
}

function previewSnippet(){
  if(!currentVideoId) return alert('Pick a song first');
  stopLoop();
  ytPlayer.loadVideoById(currentVideoId, snippetStart);
  loopInterval = setInterval(()=>{ ytPlayer.seekTo(snippetStart); }, snippetLength * 1000);
}
function stopLoop(){ if(loopInterval){ clearInterval(loopInterval); loopInterval=null; } }

function saveSnippetLocal(){
  if(!currentVideoId) return alert('Pick a song first');
  const lyrics = byId('lyrics').value;
  const song = { videoId: currentVideoId, snippetStart, snippetLength, lyrics };
  localSaveSong(song);
  alert('Saved to localStorage');
}

// YouTube API
function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player('player', {height:'360', width:'640', videoId:null, events: { 'onReady': onPlayerReady }});
}
function onPlayerReady(ev){ console.log('YT ready'); }

// UI wiring
function wireUI(){
  byId('loadPlaylist').addEventListener('click', async ()=>{ await loadPlaylist(''); });

  byId('playlistItems').addEventListener('click', async (ev)=>{
    const btn = ev.target.closest('button'); if(!btn) return; const vid = btn.getAttribute('data-id');
    if(btn.classList.contains('play')){
      const s = localGetSong(vid);
      byId('snippetStart').value = s ? s.snippetStart : 0;
      byId('snippetLength').value = s ? s.snippetLength : 30;
      byId('lyrics').value = s ? s.lyrics : '';
      currentVideoId = vid; snippetStart = Number(byId('snippetStart').value); snippetLength = Number(byId('snippetLength').value);
      playSong(vid);
    } else if(btn.classList.contains('edit')){
      const s = localGetSong(vid);
      byId('snippetStart').value = s ? s.snippetStart : 0;
      byId('snippetLength').value = s ? s.snippetLength : 30;
      byId('lyrics').value = s ? s.lyrics : '';
      currentVideoId = vid; snippetStart = Number(byId('snippetStart').value); snippetLength = Number(byId('snippetLength').value);
    }
  });

  byId('previewSnippet').addEventListener('click', ()=>{ snippetStart = Number(byId('snippetStart').value); snippetLength = Number(byId('snippetLength').value); previewSnippet(); });
  byId('saveSnippet').addEventListener('click', ()=>{ snippetStart = Number(byId('snippetStart').value); snippetLength = Number(byId('snippetLength').value); saveSnippetLocal(); });

  byId('exportData').addEventListener('click', ()=>{
    const data = getSaved('karaoke:saved') || {};
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'karaoke-saved.json'; a.click(); URL.revokeObjectURL(url);
  });

  const importFile = byId('importFile');
  byId('importData').addEventListener('click', ()=>{ importFile.click(); });
  importFile.addEventListener('change', (ev)=>{
    const f = ev.target.files[0]; if(!f) return; const reader = new FileReader(); reader.onload = (e)=>{
      try{ const obj = JSON.parse(e.target.result); setSaved('karaoke:saved', obj); alert('Imported'); }catch(err){ alert('Invalid JSON'); }
    }; reader.readAsText(f);
  });

  setInterval(()=>{ if(!ytPlayer || !ytPlayer.getPlayerState) return; const state = ytPlayer.getPlayerState(); if(state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) stopLoop(); }, 500);
}

window.addEventListener('DOMContentLoaded', async ()=>{ wireUI(); await loadPlaylist(''); });
