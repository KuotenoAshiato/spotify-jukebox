const socket = io();

const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');

// Wenn kein Raum in der URL steht, fragen wir den User danach
if (!roomId) {
    alert("Kein Party-Code gefunden! Du wirst zur Startseite weitergeleitet.");
    window.location.href = "index";
    throw new Error("Abbruch: Keine Raum-ID vorhanden."); // Stoppt die weitere Ausführung des Skripts
}

function generateQRCode() {
    // Holt sich automatisch deine aktuelle Domain/IP (z.B. http://192.168.178.50:8080)
    const baseUrl = window.location.origin;
    
    // Baut den exakten Gast-Link für diesen Raum zusammen
    const guestUrl = `${baseUrl}/guest?room=${encodeURIComponent(roomId)}`;
    
    // Nutzt eine kostenlose API, um den Link on-the-fly in ein QR-Code Bild zu verwandeln
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(guestUrl)}`;
    
    // Setzt das Bild und den Text im HTML
    const qrImgElement = document.getElementById('qr-code-img');
    
    if (qrImgElement) qrImgElement.src = qrImageUrl;
    if (qrTextElement) qrTextElement.innerText = guestUrl;
}

// Rufe die Funktion auf, sobald die Seite geladen ist
window.addEventListener('DOMContentLoaded', generateQRCode);

// Sobald die Socket-Verbindung steht, treten wir dem Raum bei
socket.on('connect', () => {
    if (roomId) socket.emit('join_room', roomId);
});

// --- STATE & GLOBALE VARIABLEN ---
let queue = []; let historyQueue = []; let accessToken = ''; 
let currentPlayingGenre = "-";
let autoDjEnabled = false;
let lastAutoDjUri = '';
let currentIsAutoDj = false;
let db = { artists: {}, genres: {}, artistNames: {} };
let currentSpotifyItem = null;
let currentIsFallback = false;
let isTransitioning = false;
let playbackMonitorInterval = null;
let rtvThreshold = 3; let rtvVotedBy = []; let genreVotedBy = {};
let showProgress = true; 
let enableVisualizer = true;

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}
// --- SOCKET EMPFANG ---
socket.on('init_state', syncState);
socket.on('state_updated', syncState);

socket.on('host_skip_track', () => { 
    isTransitioning = true; playNextFromCustomQueue(currentSpotifyItem); 
});

function syncState(serverState) {
    queue = serverState.queue || [];
    historyQueue = serverState.historyQueue || [];
    db = serverState.db || { artists: {}, genres: {}, artistNames: {} };
    accessToken = serverState.accessToken || '';
    autoDjEnabled = serverState.autoDjEnabled || false;
    
    rtvThreshold = serverState.rtvThreshold || 3;
    rtvVotedBy = serverState.rtvVotedBy || [];
    genreVotedBy = serverState.genreVotedBy || {};

    // Layout Werte global setzen
    showProgress = serverState.showProgress !== false;
    enableVisualizer = serverState.enableVisualizer !== false;
    
    const showSearch = serverState.showSearch !== false;
    const showSidebar = serverState.showSidebar !== false;
    const showQr = serverState.showQr !== false;
    
    if (accessToken) {
        document.getElementById('waiting-msg').style.display = 'none';
        document.getElementById('neon-coverflow').style.display = 'flex';
        
        const searchContainer = document.getElementById('guest-search-container');
        if (searchContainer) searchContainer.style.display = showSearch ? 'block' : 'none';
        
        const sidebar = document.getElementById('jukebox-sidebar');
        if (sidebar) sidebar.style.display = showSidebar ? 'flex' : 'none';
        
        const qrContainer = document.getElementById('qr-container');
        if (qrContainer) qrContainer.style.display = showQr ? 'block' : 'none';
        
        const coverImg = document.getElementById('cf-current-img');
        if (coverImg) {
            if (enableVisualizer) {
                coverImg.classList.add('visualizer-pulse');
            } else {
                coverImg.classList.remove('visualizer-pulse');
                // Wichtig: Hart pausieren
                coverImg.style.animationPlayState = 'paused'; 
            }
        }

        if (!playbackMonitorInterval) startPlaybackMonitor();
    }
    
    // Diese Befehle dürfen vom Absturz nicht blockiert werden:
    if (typeof renderCoverflow === "function") renderCoverflow();
    if (typeof renderSidebar === "function") renderSidebar();
}

function pushState() {
    socket.emit('update_state', { queue, historyQueue, currentPlayingGenre });
}

async function updateVisualizer(trackId) {
    if (!accessToken || !trackId) return;
    
    // WORKAROUND: Da Spotify die Audio-Features gesperrt hat, faken wir den Puls.
    // Wir setzen einfach einen entspannten 120 BPM Beat (0.5 Sekunden).
    const coverImg = document.getElementById('cf-current-img');
    if (coverImg) {
        coverImg.style.animationDuration = `0.5s`;
    }
}

// --- SPOTIFY DJ LOGIK ---
function startPlaybackMonitor() {
    playbackMonitorInterval = setInterval(async () => {
        if (!accessToken || isTransitioning) return;
        try {
            // KORRIGIERTER LINK:
            const res = await fetch('https://api.spotify.com/v1/me/player', { headers: { 'Authorization': 'Bearer ' + accessToken } });
            if (res.status === 204) return;
            const data = await res.json();
            if (!data || !data.item) return;
            
            const progressWrapper = document.getElementById('progress-wrapper');
            const progressBar = document.getElementById('progress-bar');
            const timeCurrent = document.getElementById('progress-time-current');
            const timeTotal = document.getElementById('progress-time-total');
            
            if (data.is_playing && showProgress) {
                progressWrapper.style.display = 'flex';
                const percent = (data.progress_ms / data.item.duration_ms) * 100;
                progressBar.style.width = percent + '%';
                timeCurrent.innerText = formatTime(data.progress_ms);
                timeTotal.innerText = formatTime(data.item.duration_ms);
            } else {
                progressWrapper.style.display = 'none';
            }
            
            if (!currentSpotifyItem || currentSpotifyItem.uri !== data.item.uri) {
                currentSpotifyItem = data.item;
                currentIsAutoDj = (data.item.uri === lastAutoDjUri);
                renderCoverflow();
                updateVisualizer(currentSpotifyItem.id);
            }
            
            const coverImg = document.getElementById('cf-current-img');
            if (coverImg) {
                coverImg.style.animationPlayState = (data.is_playing && enableVisualizer) ? 'running' : 'paused';
            }

            const timeLeft = data.item.duration_ms - data.progress_ms;
            if (data.is_playing && timeLeft < 4000) {
                isTransitioning = true; 
                const exactDelay = Math.max(0, timeLeft - 400);
                setTimeout(() => {
                    if (queue.length > 0) {
                        playNextFromCustomQueue(data.item);
                    } else if (autoDjEnabled) {
                        startAutoDJMusic(data.item);
                    } else {
                        isTransitioning = false; 
                    }
                }, exactDelay);
            }
        } catch (error) {}
    }, 2000);
}

async function playNextFromCustomQueue(finishedItem) {
    if (finishedItem) {
        const cover = finishedItem.album?.images[0]?.url || '';
        historyQueue.unshift({ name: finishedItem.name, artist: finishedItem.artists.map(a => a.name).join(', '), uri: finishedItem.uri, cover });
        if (historyQueue.length > 30) historyQueue.pop(); 
    }
    const nextTrack = queue.shift();
    if (nextTrack) {
        socket.emit('update_state', { 
            queue, 
            historyQueue, 
            currentPlayingGenre: nextTrack.genre 
        });
    } else {
        socket.emit('update_state', { queue, historyQueue, currentPlayingGenre: "-" });
    }
    
    if (!nextTrack) { isTransitioning = false; return; }
    
    try {
        await fetch('https://api.spotify.com/v1/me/player/play', { 
            method: 'PUT', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ uris: [nextTrack.uri] }) 
        });
        setTimeout(() => { isTransitioning = false; }, 3000);
    } catch (e) { isTransitioning = false; }
}

async function startAutoDJMusic(finishedItem) {
    // 1. Gespielten Song in die Historie eintragen
    if (finishedItem) {
        const cover = finishedItem.album?.images[0]?.url || '';
        historyQueue.unshift({ name: finishedItem.name, artist: finishedItem.artists.map(a => a.name).join(', '), uri: finishedItem.uri, cover });
        if (historyQueue.length > 30) historyQueue.pop();
        pushState();
    }

    // 2. Suchbegriff festlegen (Standard: letzter Künstler)
    let searchQuery = "year:2023-2024"; 
    if (historyQueue.length > 0) {
        // Nimm nur den Hauptkünstler und schneide Leerzeichen ab
        const lastArtist = historyQueue[0].artist.split(',')[0].trim(); 
        searchQuery = `artist:${lastArtist}`; 
    }

    try {
        // WICHTIG: Echte Spotify-API URL! Wir holen 20 Tracks, um genug Auswahl zu haben.
        let searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=20`;
        
        let res = await fetch(searchUrl, { 
            headers: { 'Authorization': 'Bearer ' + accessToken } 
        });
        let data = await res.json();
        
        // 3. FALLBACK: Wenn die Suche nach dem Künstler fehlschlägt (z.B. komischer Name oder keine Ergebnisse)
        // -> Retten wir die Situation, indem wir nach aktuellen Hits suchen, damit die Musik nie stoppt!
        if (!data.tracks || data.tracks.items.length === 0) {
            console.log("Auto-DJ: Keine Songs vom Künstler gefunden. Nutze Fallback...");
            searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent("year:2024")}&type=track&limit=20`;
            res = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + accessToken } });
            data = await res.json();
        }

        // 4. Song auswählen und starten
        if (data.tracks && data.tracks.items.length > 0) {
            // Wähle einen zufälligen Song aus den gelieferten Ergebnissen
            const randomIndex = Math.floor(Math.random() * data.tracks.items.length);
            const recTrack = data.tracks.items[randomIndex];
            
            lastAutoDjUri = recTrack.uri;
            
            // WICHTIG: Echte Spotify-API URL um den Player zu starten!
            await fetch('https://api.spotify.com/v1/me/player/play', { 
                method: 'PUT', 
                headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ uris: [recTrack.uri] }) 
            });
            console.log("Auto-DJ hat gestartet:", recTrack.name);
        } else {
             console.log("Auto-DJ: Absolut keine Suchergebnisse gefunden. Musik stoppt.");
        }
        
        setTimeout(() => { isTransitioning = false; }, 3000);
    } catch (e) { 
        console.error("Auto-DJ Fehler", e);
        isTransitioning = false; 
    }
}

// --- 3D RENDERING ---
function renderCoverflow() {
    if (currentSpotifyItem) {
        const label = document.getElementById('neon-fallback-label');
        label.innerText = 'Auto-DJ (Passend zum Vibe)';
        label.style.display = currentIsAutoDj ? 'block' : 'none';
        document.getElementById('neon-title').innerText = currentSpotifyItem.name;
        document.getElementById('neon-artist').innerText = currentSpotifyItem.artists.map(artist => artist.name).join(', ');
        if (currentSpotifyItem.album?.images.length > 0) document.getElementById('cf-current-img').src = currentSpotifyItem.album.images[0].url;
    }

    const histDiv = document.getElementById('cf-history'); histDiv.innerHTML = '';
    historyQueue.slice(0, 3).forEach(track => { if (track.cover) histDiv.innerHTML += `<img src="${track.cover}">`; });

    const queueDiv = document.getElementById('cf-queue'); queueDiv.innerHTML = '';
    if (queue.length > 0) {
        queue.slice(0, 3).forEach(track => { if (track.cover) queueDiv.innerHTML += `<img src="${track.cover}">`; });
    }
    // Die alte "else if (fallbackPlaylistUri...)" Logik wurde hier komplett entfernt, da sie den Absturz verursacht hat.
}
function renderSidebar() {
    // 1. Warteschlange (max. 6 Songs anzeigen, damit es auf den Bildschirm passt)
    const queueList = document.getElementById('display-queue-list');
    queueList.innerHTML = '';
    
    if (queue.length === 0) {
        queueList.innerHTML = '<div style="color: gray; font-size: 14px; text-align: center; margin-top: 20px;">Die Warteschlange ist leer.</div>';
    } else {
        queue.slice(0, 6).forEach((track, i) => {
            const isFirst = i === 0; // Der allererste Song wird grün markiert
            queueList.innerHTML += `
                <div style="display: flex; align-items: center; background: rgba(0, 0, 0, 0.6); border: 1px solid #ff8c00; padding: 8px; border-radius: 8px; margin-bottom: 5px; border-left: 3px solid ${isFirst ? '#1DB954' : '#ff8c00'};">
                    ${track.cover ? `<img src="${track.cover}" style="width: 35px; height: 35px; border-radius: 4px; margin-right: 10px; border: 1px solid #333;">` : ''}
                    <div style="flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">
                        <div style="color: #fff; font-size: 13px; font-weight: bold; overflow: hidden; text-overflow: ellipsis;">${track.name}</div>
                        <div style="color: #aaa; font-size: 11px; overflow: hidden; text-overflow: ellipsis;">${track.artist}</div>
                    </div>
                    <div style="margin-left: 5px; text-align: right;">
                        <div style="color: ${track.votes ? '#1DB954' : '#555'}; font-size: 13px; font-weight: bold; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 6px;">
                            ⇧ ${track.votes || 0}
                        </div>
                    </div>
                </div>
            `;
        });
    }

    // 2. RTV Status updaten
    document.getElementById('display-rtv-status').innerText = `${rtvVotedBy.length} / ${rtvThreshold}`;

    // 3. Top-Genres Ranking anzeigen
    const genreList = document.getElementById('display-genre-votes');
    genreList.innerHTML = '';
    
    const currentGenre = queue.length > 0 ? queue[0].genre : null;
    const uniqueGenres = [...new Set(queue.map(t => t.genre))].filter(g => g !== currentGenre);
    
    if (uniqueGenres.length === 0) {
        genreList.innerHTML = '<span style="color: gray; font-size: 11px; text-align: center; display: block;">Keine anderen Genres in der Warteschlange.</span>';
    } else {
        // Genres nach Votes sortieren und die Top 3 anzeigen
        uniqueGenres.sort((a, b) => (genreVotedBy[b]?.length || 0) - (genreVotedBy[a]?.length || 0)).slice(0, 3).forEach((genre, index) => {
            const votes = genreVotedBy[genre] ? genreVotedBy[genre].length : 0;
            const medals = ['1.', '2.', '3.'];
            genreList.innerHTML += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,140,0,0.1); padding: 6px 8px; border-radius: 6px; border: 1px solid #ff8c00; margin-bottom: 4px;">
                    <span style="color: #ffd700; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 170px;">${medals[index] || ''} ${genre}</span>
                    <span style="color: #fff; font-weight: bold; background: #333; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${votes} Votes</span>
                </div>
            `;
        });
    }
}
// --- GAST LOGIK (Suche & Hinzufügen ohne Chip-Menü) ---
async function guestSearchSong() {
    const query = document.getElementById('guest-search-input').value;
    if(!query || !accessToken) return;
    
    const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=4`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    const data = await res.json();
    
    const div = document.getElementById('guest-search-results');
    div.innerHTML = '';
    
    data.tracks.items.forEach(track => {
        const cover = track.album.images.length > 0 ? track.album.images[0].url : '';
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block; width:100%; margin-bottom:5px; padding: 10px; text-align:left; background: transparent; color: #fff; border: 1px solid #ff8c00; cursor: pointer; font-family: sans-serif;';
        btn.innerHTML = `<strong style="color: #ff8c00;">${track.name}</strong> <br> <small>${track.artists.map(a => a.name).join(', ')}</small>`;
        btn.onclick = () => guestProcessTrack(track.uri, track.name, track.artists[0].name, track.artists[0].id, cover);
        div.appendChild(btn);
    });
}

// NEU: Hilfsfunktion für die Jukebox (falls sie nicht schon da ist)
async function getArtistGenres(artistId) {
    if (!accessToken) return [];
    try { 
        const res = await fetch('https://api.spotify.com/v1/artists/' + artistId, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const data = await res.json();
        return data.genres || []; 
    } catch (e) { return []; }
}

// UPDATE: Die smarte Hinzufügen-Logik für das Display
async function guestProcessTrack(uri, name, artist, artistId, cover) {
    document.getElementById('guest-search-results').innerHTML = '<p style="color: #ff8c00; padding: 10px;">Song wird an den Server gesendet...</p>';
    
    // Logik an Server delegieren
    socket.emit('add_track', { uri, name, artist, artistId, cover });
    
    document.getElementById('guest-search-input').value = '';
    document.getElementById('guest-search-results').innerHTML = '';
}
