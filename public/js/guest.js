const socket = io();

// --- NEU: Geräte-ID für den Anti-Cheat-Schutz ---
let deviceId = localStorage.getItem('jukebox_deviceId');
if (!deviceId) {
    // Wenn das Gerät noch keine ID hat, generieren wir eine zufällige
    deviceId = 'device_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem('jukebox_deviceId', deviceId);
}

const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');

// Wenn kein Raum in der URL steht, fragen wir den User danach
if (!roomId) {
    alert("Kein Party-Code gefunden! Du wirst zur Startseite weitergeleitet.");
    window.location.href = "index";
    throw new Error("Abbruch: Keine Raum-ID vorhanden."); // Stoppt die weitere Ausführung des Skripts
}

// Sobald die Socket-Verbindung steht, treten wir dem Raum bei
socket.on('connect', () => {
    if (roomId) socket.emit('join_room', roomId);
});

let queue = []; let db = { artists: {}, genres: {}, artistNames: {} }; let accessToken = '';
let lastNotifiedSongId = null; // Verhindert, dass das Handy dauerhaft vibriert
socket.on('init_state', syncState);
socket.on('state_updated', syncState);

function syncState(serverState) {
    queue = serverState.queue || [];
    db = serverState.db || { artists: {}, genres: {}, artistNames: {} };
    accessToken = serverState.accessToken || '';
    
    if(accessToken) {
        document.getElementById('status-msg').innerText = "Verbunden! Such deinen Song.";
        document.getElementById('status-msg').style.color = "#1DB954";
        setTimeout(() => document.getElementById('status-msg').style.display = 'none', 3000);
    }
    renderGuestQueue();
    renderGenreVoting(serverState);
    // --- NEU: "Dein Song ist dran!" Benachrichtigung ---
    if (queue.length > 0) {
        const nextTrack = queue[0];
        // Prüfen: Ist der nächste Song meiner? Und habe ich dafür noch keine Benachrichtigung bekommen?
        if (nextTrack.requestedBy === deviceId && nextTrack.uniqueId !== lastNotifiedSongId) {
            
            lastNotifiedSongId = nextTrack.uniqueId; // Merken, dass wir schon vibriert haben
            
            // 1. VIBRIEREN (Muster: 200ms an, 100ms Pause, 200ms an)
            if (navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
            }

            // 2. SCHICKES POP-UP ANZEIGEN
            const popup = document.createElement('div');
            popup.style.cssText = "position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, #1DB954, #128039); color: white; padding: 15px 25px; border-radius: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.8); z-index: 9999; font-weight: bold; text-align: center; width: 80%; max-width: 350px; border: 2px solid #ffd700; animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;";
            popup.innerHTML = `<strong>Mach dich bereit!</strong><br><span style="font-size: 13px; font-weight: normal;">Dein Wunsch "${nextTrack.name}" ist als Nächstes dran!</span>`;
            
            document.body.appendChild(popup);
            
            // Pop-up nach 6 Sekunden wieder ausblenden
            setTimeout(() => {
                popup.style.animation = "popOut 0.5s ease-in forwards";
                setTimeout(() => popup.remove(), 500);
            }, 6000);
        }
    }
}
function renderGenreVoting(serverState) {
    const section = document.getElementById('genre-voting-section');
    if (!queue || queue.length === 0) {
        section.style.display = 'none'; return;
    }
    section.style.display = 'block';

    const currentGenre = (serverState.currentPlayingGenre && serverState.currentPlayingGenre !== "-") 
        ? serverState.currentPlayingGenre 
        : (queue.length > 0 ? queue[0].genre : "Unbekannt");
    document.getElementById('active-genre-display').innerText = `Aktuell spielt: ${currentGenre}`;

    // RTV Button Logik
    let rtvThreshold = serverState.rtvThreshold || 3;
    let rtvVotedBy = serverState.rtvVotedBy || [];
    let genreVotedBy = serverState.genreVotedBy || {};

    const rtvBtn = document.getElementById('rtv-btn');
    const hasVotedRtv = rtvVotedBy.includes(deviceId);
    rtvBtn.innerText = `RTV - Aktuelles Genre skippen (${rtvVotedBy.length}/${rtvThreshold})`;
    rtvBtn.style.background = hasVotedRtv ? 'rgba(255,255,255,0.1)' : 'rgba(226, 33, 52, 0.2)';
    rtvBtn.style.border = hasVotedRtv ? '1px solid #555' : '1px solid #E22134';
    rtvBtn.style.color = hasVotedRtv ? '#777' : '#E22134';
    rtvBtn.disabled = hasVotedRtv;

    // Einzigartige Genres finden (ohne das aktuell laufende)
    const uniqueGenres = [...new Set(queue.map(t => t.genre))].filter(g => g !== currentGenre);
    
    const list = document.getElementById('genre-vote-list');
    list.innerHTML = '';
    
    if (uniqueGenres.length === 0) {
        list.innerHTML = '<p style="color: gray; font-size: 12px; text-align: center;">Keine anderen Genres in der Warteschlange.</p>';
    } else {
        uniqueGenres.forEach(genre => {
            const votes = genreVotedBy[genre] ? genreVotedBy[genre].length : 0;
            const hasVotedThis = genreVotedBy[genre] && genreVotedBy[genre].includes(deviceId);
            const btnColor = hasVotedThis ? '#1DB954' : '#333';
            
            list.innerHTML += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,140,0,0.1); border: 1px solid #ff8c00; padding: 10px 12px; border-radius: 6px; margin-bottom: 8px;">
                    <span style="color: #ffd700; font-size: 14px;">${genre}</span>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="color: #fff; font-size: 12px;">${votes} Votes</span>
                        <button onclick="voteGenre('${genre}')" ${hasVotedThis ? 'disabled' : ''} style="background: ${hasVotedThis ? 'rgba(29, 185, 84, 0.2)' : 'transparent'}; border: 1px solid ${hasVotedThis ? '#1DB954' : '#ff8c00'}; color: ${hasVotedThis ? '#1DB954' : '#ff8c00'}; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 16px; cursor: pointer;">+</button>
                    </div>
                </div>
            `;
        });
    }
}

function voteRTV() { socket.emit('vote_rtv', deviceId); }
function voteGenre(genre) { socket.emit('vote_genre', { genre, deviceId }); }
function renderGuestQueue() {
    const list = document.getElementById('guest-queue-list');
    if (!list) return;
    list.innerHTML = '';
    
    if (queue.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: rgba(255,255,255,0.5);">Noch keine Songs in der Warteschlange.</p>';
        return;
    }

    let currentGenre = null;
    queue.forEach((track) => {
        // Genre-Trennlinie zeichnen
        if (track.genre !== currentGenre) {
            currentGenre = track.genre;
            list.innerHTML += `<div style="background: rgba(255, 140, 0, 0.1); border-bottom: 1px solid #ff8c00; padding: 8px 12px; margin: 20px 0 10px 0; color: #ff8c00; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">${currentGenre}</div>`;
        }
        
        // Prüfen, ob DIESES Handy schon für den Song gestimmt hat
        const hasVoted = track.votedBy && track.votedBy.includes(deviceId);
        const voteColor = hasVoted ? '#1DB954' : '#555';
        
        list.innerHTML += `
            <div style="display: flex; align-items: center; background: rgba(0, 0, 0, 0.6); border: 1px solid #ff8c00; padding: 10px; border-radius: 8px; margin-bottom: 5px; border-left: 3px solid ${hasVoted ? '#1DB954' : '#ff8c00'};">
                ${track.cover ? `<img src="${track.cover}" style="width: 40px; height: 40px; border-radius: 4px; margin-right: 10px; border: 1px solid #444;">` : ''}
                <div style="flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-right: 10px;">
                    <div style="color: #fff; font-size: 14px; font-weight: bold;">${track.name}</div>
                    <div style="color: #aaa; font-size: 12px;">${track.artist}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="color: #ff8c00; font-size: 14px; font-weight: bold;">${track.votes || 0}</span>
                    <button onclick="upvoteTrack('${track.uniqueId || track.uri}')" ${hasVoted ? 'disabled' : ''} style="background: transparent; border: 2px solid ${voteColor}; color: ${voteColor}; border-radius: 50%; width: 34px; height: 34px; cursor: ${hasVoted ? 'default' : 'pointer'}; font-size: 18px; font-weight: bold; display: flex; justify-content: center; align-items: center; transition: 0.2s;">
                        ⇧
                    </button>
                </div>
            </div>
        `;
    });
}

function upvoteTrack(uniqueId) {
    socket.emit('upvote_track', { uniqueId: uniqueId, deviceId: deviceId });
}

async function searchSong() {
    const query = document.getElementById('guest-search-input').value;
    if(!query || !accessToken) return;
    
    document.getElementById('search-results').innerHTML = '<p style="color: #ff8c00;">Suche läuft...</p>';
    
    try {
        const res = await fetch(`https://api.spotify.com/v1/search?q=$${encodeURIComponent(query)}&type=track&limit=8`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const data = await res.json();
        
        const div = document.getElementById('search-results');
        div.innerHTML = '';
        
        data.tracks.items.forEach(track => {
            const cover = track.album.images.length > 0 ? track.album.images[0].url : '';
            const item = document.createElement('div');
            item.className = 'result-item';
            item.innerHTML = `
                <img src="${cover}" alt="Cover">
                <div class="result-text-container">
                    <div class="result-title">${track.name}</div>
                    <div class="result-artist">${track.artists.map(a => a.name).join(', ')}</div>
                </div>
                <div class="add-btn-container">+</div>
            `;
            item.onclick = () => addSongToQueue(track.uri, track.name, track.artists[0].name, track.artists[0].id, cover);
            div.appendChild(item);
        });
    } catch(e) { document.getElementById('search-results').innerHTML = '<p style="color: red;">Fehler bei der Suche.</p>'; }
}

// NEU: Hilfsfunktion, um Spotify heimlich nach Genres zu fragen
async function getArtistGenres(artistId) {
    if (!accessToken) return [];
    try { 
        const res = await fetch('https://api.spotify.com/v1/artists/' + artistId, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const data = await res.json();
        return data.genres || []; 
    } catch (e) { return []; }
}

// UPDATE: Die smarte Hinzufügen-Logik
async function addSongToQueue(uri, name, artist, artistId, cover) {
    document.getElementById('search-results').innerHTML = '<p style="color: #ff8c00;">Song wird an die Jukebox gesendet...</p>';

    // Der Server macht jetzt die ganze Arbeit!
    socket.emit('add_track', { uri, name, artist, artistId, cover, requestedBy: deviceId });
    
    document.getElementById('guest-search-input').value = '';
    document.getElementById('search-results').innerHTML = `
        <div style="background: rgba(29, 185, 84, 0.1); border: 1px solid #1DB954; color: #1DB954; padding: 20px; border-radius: 8px; text-align: center; font-family: 'Orbitron', sans-serif;">
            <h3 style="margin: 0 0 10px 0;">Song gesendet!</h3>
            <p style="margin: 0; font-size: 14px;">Er wird nun einsortiert.</p>
        </div>
    `;
    
    setTimeout(() => { 
        if(document.getElementById('guest-search-input').value === '') {
            document.getElementById('search-results').innerHTML = ''; 
        }
    }, 4000);
}
