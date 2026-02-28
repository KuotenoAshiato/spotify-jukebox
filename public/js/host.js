const socket = io();
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room') || urlParams.get('state');


if (!roomId) {
    alert("⚠️ Kein Party-Code gefunden! Du wirst zur Startseite weitergeleitet.");
    window.location.href = "index";
    throw new Error("Abbruch: Keine Raum-ID vorhanden.");
}

socket.on('connect', () => {
    if (roomId) socket.emit('join_room', roomId);
});

let isHostAuthenticated = false;
let currentRoomPasswordHash = null;

if (sessionStorage.getItem('hostUnlocked') === 'true') {
    document.getElementById('password-overlay').style.display = 'none';
    isHostAuthenticated = true;
}

async function handlePasswordSubmit() {
    const pwdInput = document.getElementById('host-password-input').value; 
    if (!pwdInput) { alert("Bitte ein Passwort eingeben!"); return; }
    const encoder = new TextEncoder();
    const data = encoder.encode(pwdInput);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    if (currentRoomPasswordHash === null) {
        currentRoomPasswordHash = hashHex;
        socket.emit('update_state', { hostPasswordHash: hashHex });
        unlockHostPanel();
    } else {
        if (hashHex === currentRoomPasswordHash) {
            unlockHostPanel();
        } else {
            alert("Falsches Passwort! Zugriff verweigert.");
        }
    }
}


let queue = []; let historyQueue = []; let db = { artists: {}, genres: {}, artistNames: {} };
let accessToken = ''; let refreshToken = ''; let autoDjEnabled = false;
let currentPlayingGenre = "-";
let hostCurrentTrack = null;
let hostMonitorInterval = null;

socket.on('init_state', syncState);
socket.on('state_updated', syncState);

let lastServerState = null; 

function syncState(serverState) {
    lastServerState = serverState;
    currentPlayingGenre = serverState.currentPlayingGenre || "-";
    currentRoomPasswordHash = serverState.hostPasswordHash || null;
    if (!isHostAuthenticated) {
        document.getElementById('password-section').style.display = 'block';
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('app-section').style.display = 'none';

        if (currentRoomPasswordHash === null) {
            document.getElementById('pwd-title').innerText = "Neuer Raum erstellt!";
            document.getElementById('pwd-desc').innerText = "Lege ein sicheres Host-Passwort für diesen Raum fest:";
            document.getElementById('pwd-btn').innerText = "Passwort speichern";
        } else {
            document.getElementById('pwd-title').innerText = "Raum gesperrt";
            document.getElementById('pwd-desc').innerText = "Bitte gib das Host-Passwort für diesen Raum ein:";
            document.getElementById('pwd-btn').innerText = "Einloggen";
        }
        return;
    }

    queue = serverState.queue || []; historyQueue = serverState.historyQueue || [];
    db = serverState.db || { artists: {}, genres: {}, artistNames: {} };
    accessToken = serverState.accessToken || '';
    autoDjEnabled = serverState.autoDjEnabled || false;
    const btnAutoDj = document.getElementById('btn-autodj');
    if (btnAutoDj) {
        btnAutoDj.innerText = autoDjEnabled ? "Auto-DJ: AN" : "Auto-DJ: AUS";
        btnAutoDj.style.background = autoDjEnabled ? "rgba(255, 140, 0, 0.2)" : "transparent";
        btnAutoDj.style.border = "1px solid #ff8c00";
        btnAutoDj.style.color = autoDjEnabled ? "#ff8c00" : "#777";
        btnAutoDj.style.boxShadow = autoDjEnabled ? "0 0 10px #ff8c00" : "none";
    }
    pendingSuggestions = serverState.pendingSuggestions || [];
    updateSuggestionBadge();
    if (document.getElementById('suggestions-modal').style.display === 'flex') {
        renderSuggestions();
    }
    renderQueue();
    renderHistory();
    if(document.getElementById('db-manager-modal').style.display === 'flex') renderDbManager();
    
    if (accessToken) {
        document.getElementById('app-section').style.display = 'block';
        document.getElementById('login-section').style.display = 'none';
        if(!hostMonitorInterval) startHostMonitor();
    } else {
        document.getElementById('app-section').style.display = 'none';
        document.getElementById('login-section').style.display = 'block';
    }
    document.getElementById('rtv-threshold-slider').value = serverState.rtvThreshold || 3;
    document.getElementById('rtv-threshold-val').innerText = serverState.rtvThreshold || 3;
    document.getElementById('rtv-current-votes').innerText = (serverState.rtvVotedBy || []).length;
    document.getElementById('toggle-search').checked = serverState.showSearch !== false;
    document.getElementById('toggle-sidebar').checked = serverState.showSidebar !== false;
    document.getElementById('toggle-qr').checked = serverState.showQr !== false;
    document.getElementById('toggle-progress').checked = serverState.showProgress !== false;
    document.getElementById('toggle-visualizer').checked = serverState.enableVisualizer !== false;
}

function updateLayout() {
    socket.emit('update_state', {
        showSearch: document.getElementById('toggle-search').checked,
        showSidebar: document.getElementById('toggle-sidebar').checked,
        showQr: document.getElementById('toggle-qr').checked,
        showProgress: document.getElementById('toggle-progress').checked,
        enableVisualizer: document.getElementById('toggle-visualizer').checked
    });
}

function updateRtvThreshold(val) {
    document.getElementById('rtv-threshold-val').innerText = val;
    socket.emit('update_state', { rtvThreshold: parseInt(val) });
}

function unlockHostPanel() {
    isHostAuthenticated = true;
    
    document.getElementById('password-section').style.display = 'none';
    document.getElementById('password-overlay').style.display = 'none';
    sessionStorage.setItem('hostUnlocked', 'true');
    
    if (lastServerState) {
        syncState(lastServerState);
    }
}

function pushState() {
    socket.emit('update_state', { 
        queue, 
        historyQueue, 
        db, 
        accessToken, 
        refreshToken, 
        hostPasswordHash: currentRoomPasswordHash, 
        currentPlayingGenre 
    });
    renderQueue();
    renderHistory();
}

function logoutSpotify() {
    socket.emit('logout_spotify');
    setTimeout(() => window.location.reload(), 500);
}

async function fetchHostPlayback() {
    if (!accessToken) return;
    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': 'Bearer ' + accessToken } });
        if (res.status === 204) return;
        const data = await res.json();
        if (data && data.item) {
            hostCurrentTrack = data.item;
            document.getElementById('current-playing-section').style.display = 'block';
            document.getElementById('host-current-title').innerText = data.item.name;
            document.getElementById('host-current-artist').innerText = data.item.artists.map(a => a.name).join(', ');
        }
    } catch(e) {}
}

function startHostMonitor() {
    fetchHostPlayback();
    hostMonitorInterval = setInterval(fetchHostPlayback, 3000);
}

async function getArtistGenres(artistId) {
    try { return (await (await fetch('https://api.spotify.com/v1/artists/' + artistId, { headers: { 'Authorization': 'Bearer ' + accessToken } })).json()).genres || []; } catch (e) { return []; }
}

let genreModalResolve = null;
function showGenreModal(trackName, rawGenres) {
    return new Promise((resolve) => {
        const modal = document.getElementById('genre-modal');
        const container = document.getElementById('modal-preset-buttons');
        container.innerHTML = `<p style="font-size:12px; color:#aaa; margin-bottom:10px;">Spotify-Tags: ${rawGenres && rawGenres.length ? rawGenres.join(', ') : 'Keine'}</p>`;
        
        const allCategories = new Set(["EDM", "Rock & Metal", "Hip-Hop & Rap", "Pop & Dance", "Hardstyle"]);
        Object.values(db.artists).forEach(g => allCategories.add(g)); Object.values(db.genres).forEach(g => allCategories.add(g)); 

        allCategories.forEach(cat => {
            const badge = document.createElement('span'); badge.innerText = cat;
            badge.style.cssText = "display: inline-block; background: rgba(255,140,0,0.1); border: 1px solid #ff8c00; color: #ff8c00; padding: 4px 8px; border-radius: 4px; margin: 2px; cursor: pointer; font-size: 12px;";
            badge.onclick = () => { document.getElementById('genre-modal-input').value = cat; closeGenreModal(true); };
            container.appendChild(badge);
        });
        document.getElementById('genre-modal-input').value = ''; 
        modal.style.display = 'flex'; genreModalResolve = resolve;  
    });
}

function closeGenreModal(saveClicked) {
    document.getElementById('genre-modal').style.display = 'none';
    if (genreModalResolve) {
        const val = document.getElementById('genre-modal-input').value.trim();
        genreModalResolve(saveClicked && val !== "" ? val : null);
        genreModalResolve = null;
    }
}

function renderDbManager() {
    const content = document.querySelector('#db-manager-modal .modal-content');
    
    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <h3 style="margin:0;">Datenbank</h3>
            <button class="btn-small danger" onclick="document.getElementById('db-manager-modal').style.display='none'">Schließen</button>
        </div>
        
        <h4 style="margin: 0 0 10px 0; color: #ff8c00; border-bottom: 1px solid #333; padding-bottom: 5px;">Künstler Zuordnungen</h4>
        <div style="max-height: 30vh; overflow-y: auto; margin-bottom: 20px; padding-right: 5px;">`;

    const artistKeys = Object.keys(db.artists).sort((a,b) => (db.artistNames[a]||a).localeCompare(db.artistNames[b]||b));
    if(artistKeys.length === 0) html += '<p style="color:gray; font-size:12px;">Noch keine Künstler gelernt.</p>';
    
    artistKeys.forEach(key => {
        const name = db.artistNames[key] || key;
        html += `
            <div class="queue-item" style="display: flex; align-items: center; background: rgba(255,255,255,0.02); border-bottom: 1px solid #333; padding: 8px; margin-bottom: 2px;">
                <div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; width: 50%; color: #ddd;">
                    ${name}
                </div>
                <div style="width: 30%; text-align: right; color: #ff8c00; font-size: 11px; margin-right: 10px;">
                    ${db.artists[key]}
                </div>
                <div style="width: 20%; text-align: right;">
                    <button class="btn-small" style="padding: 2px 6px;" onclick="editDbEntry('artists', '${key}')">Edit</button>
                    <button class="btn-small btn-danger" style="padding: 2px 6px;" onclick="delete db.artists['${key}']; pushState(); renderDbManager();">Del</button>
                </div>
            </div>`;
    });

    html += `</div>
        <h4 style="margin: 0 0 10px 0; color: #ff8c00; border-bottom: 1px solid #333; padding-bottom: 5px;">Spotify Raw Genres</h4>
        <div style="max-height: 30vh; overflow-y: auto; padding-right: 5px;">`;

    const genreKeys = Object.keys(db.genres).sort();
    if(genreKeys.length === 0) html += '<p style="color:gray; font-size:12px;">Noch keine Genres gelernt.</p>';

    genreKeys.forEach(key => {
        html += `
            <div class="queue-item" style="display: flex; align-items: center; background: rgba(255,255,255,0.02); border-bottom: 1px solid #333; padding: 8px; margin-bottom: 2px;">
                <div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; width: 50%; color: #aaa;">
                    ${key}
                </div>
                <div style="width: 30%; text-align: right; color: #ff8c00; font-size: 11px; margin-right: 10px;">
                    ${db.genres[key]}
                </div>
                <div style="width: 20%; text-align: right;">
                    <button class="btn-small" style="padding: 2px 6px;" onclick="editDbEntry('genres', '${key}')">Edit</button>
                    <button class="btn-small btn-danger" style="padding: 2px 6px;" onclick="delete db.genres['${key}']; pushState(); renderDbManager();">Del</button>
                </div>
            </div>`;
    });

    html += `</div>`;
    content.innerHTML = html;
}

async function editDbEntry(type, key) {
    let displayName = key;
    if (type === 'artists') {
        displayName = db.artistNames[key] || key;
    }

    document.getElementById('db-manager-modal').style.display = 'none';

    let manualGenre = await showGenreModal(displayName, []);

    if (manualGenre) {
        db[type][key] = manualGenre;
        pushState();
    }

    renderDbManager();
    document.getElementById('db-manager-modal').style.display = 'flex';
}

let currentTrackMenuIndex = -1;
function openTrackMenu(index) {
    currentTrackMenuIndex = index;
    document.getElementById('track-menu-name').innerText = queue[index].name;
    document.getElementById('track-action-modal').style.display = 'flex';
}
function closeTrackMenu() { document.getElementById('track-action-modal').style.display = 'none'; }

function deleteTrackFromMenu() {
    if(currentTrackMenuIndex > -1) { queue.splice(currentTrackMenuIndex, 1); pushState(); closeTrackMenu(); }
}

async function editGenreFromMenu() {
    const index = currentTrackMenuIndex;
    closeTrackMenu();
    if (index > -1) {
        const track = queue[index];
        const rawGenres = await getArtistGenres(track.artistId);
        let manualGenre = await showGenreModal(track.name, rawGenres);
        
        if (manualGenre) {
            db.artists[track.artistId] = manualGenre; 
            db.artistNames[track.artistId] = track.artist;
            
            rawGenres.forEach(raw => db.genres[raw] = manualGenre);

            queue.splice(index, 1); track.genre = manualGenre;
            
            let inserted = false;
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].genre === manualGenre) { queue.splice(i + 1, 0, track); inserted = true; break; }
            }
            if (!inserted) queue.push(track);
            pushState();
        }
    }
}

async function searchSong() {
    const query = document.getElementById('search-input').value;
    if(!query || !accessToken) return;
    const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    if (res.status === 401) return alert("Sitzung abgelaufen!");
    const data = await res.json();
    const div = document.getElementById('search-results'); div.innerHTML = '';
    data.tracks.items.forEach(track => {
        const cover = track.album.images.length > 0 ? track.album.images[0].url : '';
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block; width:100%; margin-bottom:5px; text-align:left; background: rgba(255,255,255,0.05); border: 1px solid #333; color: #fff; padding: 10px; border-radius: 4px; font-family: "Orbitron", sans-serif; cursor: pointer;';
        btn.innerHTML = `<strong style="color: #ff8c00;">${track.name}</strong> <br> <small style="color: #aaa;">${track.artists.map(a => a.name).join(', ')}</small>`;
        btn.onclick = () => processTrack(track.uri, track.name, track.artists.map(a => a.name).join(', '), track.artists[0].id, cover);
        div.appendChild(btn);
    });
}

let currentSuggestion = null;

let pendingSuggestions = [];

socket.on('ask_genre_adoption', (data) => {
    if (!pendingSuggestions.some(s => s.artistId === data.artistId)) {
        pendingSuggestions.push(data);
        updateSuggestionBadge();
        
        if (document.getElementById('suggestions-modal').style.display === 'flex') {
            renderSuggestions();
        }
    }
});

function openSuggestionsModal() {
    renderSuggestions();
    document.getElementById('suggestions-modal').style.display = 'flex';
}

function renderSuggestions() {
    const list = document.getElementById('suggestions-list');
    list.innerHTML = '';
    
    if (pendingSuggestions.length === 0) {
        list.innerHTML = '<p style="color: gray; text-align: center;">Keine neuen Vorschläge vorhanden.</p>';
        return;
    }

    pendingSuggestions.forEach((suggestion, index) => {
        list.innerHTML += `
            <div class="queue-item" style="padding: 12px; background: rgba(255,255,255,0.03); border: 1px solid #333; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #ff8c00; display: flex; align-items: center; justify-content: space-between;">
                <div style="flex: 1; overflow: hidden; margin-right: 10px;">
                    <strong style="color: #fff; font-size: 15px;">${suggestion.artist}</strong><br>
                    <span style="color: #aaa; font-size: 12px;">Vorschlag: <strong style="color: #ff8c00;">${suggestion.suggestedGenre}</strong></span>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn-small" style="background: rgba(29, 185, 84, 0.2); border-color: #1DB954; color: #1DB954;" title="Übernehmen" onclick="acceptSuggestion(${index})">OK</button>
                    <button class="btn-small" style="border-color: #ff8c00; color: #ff8c00;" title="Bearbeiten" onclick="editSuggestion(${index})">Edit</button>
                    <button class="btn-small btn-danger" title="Verwerfen" onclick="rejectSuggestion(${index})">Del</button>
                </div>
            </div>
        `;
    });
}

function askToSaveTags(artistName, tagsArray, genreName) {
    return new Promise((resolve) => {
        document.getElementById('tags-modal-artist').innerText = artistName;
        document.getElementById('tags-modal-list').innerText = tagsArray.join(', ');
        document.getElementById('tags-modal-genre').innerText = genreName;
        
        document.getElementById('save-tags-modal').style.display = 'flex';
        
        document.getElementById('btn-save-tags').onclick = () => {
            document.getElementById('save-tags-modal').style.display = 'none';
            resolve(true);
        };
        
        document.getElementById('btn-ignore-tags').onclick = () => {
            document.getElementById('save-tags-modal').style.display = 'none';
            resolve(false);
        };
    });
}

async function acceptSuggestion(index) {
    const data = pendingSuggestions[index];
    let genresToSave = []; 
    
    if (data.rawGenres && data.rawGenres.length > 0) {
        document.getElementById('suggestions-modal').style.display = 'none';
        
        const wantToSaveTags = await askToSaveTags(data.artist, data.rawGenres, data.suggestedGenre);
        
        if (wantToSaveTags) {
            genresToSave = data.rawGenres; 
        }
        
        document.getElementById('suggestions-modal').style.display = 'flex';
    }

    socket.emit('update_track_genre', {
        artistId: data.artistId,
        artistName: data.artist,
        newGenre: data.suggestedGenre,
        rawGenres: genresToSave 
    });
    
    pendingSuggestions.splice(index, 1);
    updateSuggestionBadge();
    renderSuggestions();
}


async function editSuggestion(index) {
    const data = pendingSuggestions[index];
    document.getElementById('suggestions-modal').style.display = 'none';
    
    const manualGenre = await showGenreModal(data.name, data.rawGenres);
    if (manualGenre) {
        socket.emit('update_track_genre', {
            artistId: data.artistId,
            artistName: data.artist,
            newGenre: manualGenre,
            rawGenres: data.rawGenres
        });
        pendingSuggestions.splice(index, 1);
    }
    
    updateSuggestionBadge();
    renderSuggestions();
    document.getElementById('suggestions-modal').style.display = 'flex';
}
function updateSuggestionBadge() {
    const badge = document.getElementById('suggestion-badge');
    const btn = document.getElementById('suggestions-btn'); 
    
    if (!badge || !btn) return;
    
    if (pendingSuggestions.length > 0) {
        badge.style.display = 'inline-block';
        badge.innerText = pendingSuggestions.length;
        btn.style.background = 'rgba(255, 140, 0, 0.2)';
        btn.style.color = '#ff8c00';
        btn.style.border = '1px solid #ff8c00';
    } else {
        badge.style.display = 'none';
        btn.style.background = 'transparent';
        btn.style.color = '#777';
        btn.style.border = '1px solid #555';
    }
}

function rejectSuggestion(index) {
    socket.emit('remove_suggestion', pendingSuggestions[index].artistId);
}

function rejectAllSuggestions() {
    socket.emit('clear_all_suggestions');
}

async function acceptAllSuggestions() {
    if (pendingSuggestions.length === 0) return;

    const hasAnyRaw = pendingSuggestions.some(d => d.rawGenres && d.rawGenres.length > 0);
    let saveTags = false;
    
    if (hasAnyRaw) {
        document.getElementById('suggestions-modal').style.display = 'none';
        
        saveTags = await askToSaveTags("Mehrere ausgewählte Künstler", ["Verschiedene Spotify-Tags"], "ihren jeweiligen Kategorien");
        
        document.getElementById('suggestions-modal').style.display = 'flex';
    }

    pendingSuggestions.forEach(data => {
        socket.emit('update_track_genre', {
            artistId: data.artistId,
            artistName: data.artist,
            newGenre: data.suggestedGenre,
            rawGenres: saveTags ? data.rawGenres : [] 
        });
    });
    
    pendingSuggestions = [];
    updateSuggestionBadge();
    renderSuggestions();
}

async function processTrack(uri, name, artist, artistId, cover) {
    document.getElementById('search-results').innerHTML = '<p style="color: #ff8c00;">Song wird eingereiht...</p>';
    
    socket.emit('add_track', { uri, name, artist, artistId, cover });
    
    document.getElementById('search-input').value = '';
    setTimeout(() => document.getElementById('search-results').innerHTML = '', 1500);
}

function moveBlockUp(startIndex) {
    const targetGenre = queue[startIndex].genre; let targetEnd = startIndex;
    while(targetEnd + 1 < queue.length && queue[targetEnd + 1].genre === targetGenre) targetEnd++;
    const prevGenre = queue[startIndex - 1].genre; let prevStart = startIndex - 1;
    while(prevStart - 1 >= 0 && queue[prevStart - 1].genre === prevGenre) prevStart--;
    const prevBlock = queue.slice(prevStart, startIndex); const targetBlock = queue.slice(startIndex, targetEnd + 1);
    queue.splice(prevStart, prevBlock.length + targetBlock.length, ...targetBlock, ...prevBlock);
    pushState();
}

function clearQueue() { queue = []; pushState(); }
function clearHistory() { historyQueue = []; pushState(); }

async function skipTrack() {
    if (!accessToken) return;
    
    if (hostCurrentTrack) {
        const cover = hostCurrentTrack.album?.images[0]?.url || '';
        historyQueue.unshift({ name: hostCurrentTrack.name, artist: hostCurrentTrack.artists.map(a => a.name).join(', '), uri: hostCurrentTrack.uri, cover });
        if (historyQueue.length > 30) historyQueue.pop();
    }
    
    const nextTrack = queue.shift();
    if (nextTrack) {
        currentPlayingGenre = nextTrack.genre;
    } else {
        currentPlayingGenre = "-";
    }
    pushState();
    
    try {
        if (nextTrack) {
            await fetch('https://api.spotify.com/v1/me/player/play', { 
                method: 'PUT', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ uris: [nextTrack.uri] }) 
            });
        } else {
            await fetch('https://api.spotify.com/v1/me/player/next', { 
                method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken } 
            });
        }
    } catch(e) { console.error("Konnte nicht skippen:", e); }
}

function toggleAutoDJ() {
    autoDjEnabled = !autoDjEnabled;
    socket.emit('update_state', { autoDjEnabled: autoDjEnabled });
}

function renderQueue() {
    const list = document.getElementById('queue-list'); list.innerHTML = '';
    let currentGenre = null;
    queue.forEach((track, index) => {
        if (track.genre !== currentGenre) {
            currentGenre = track.genre;
            list.innerHTML += `<li class="genre-block-header" style="background: rgba(255, 140, 0, 0.1); border-bottom: 1px solid #ff8c00; padding: 8px 12px; margin: 20px 0 10px 0; color: #ff8c00; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; display: flex; justify-content: space-between; align-items: center;"><span>${currentGenre}</span> ${index > 0 ? `<button class="btn-small" onclick="moveBlockUp(${index})">UP</button>` : ''}</li>`;
        }
        list.innerHTML += `
            <li class="queue-item" style="display: flex; align-items: center; background: rgba(255,255,255,0.03); border: 1px solid #333; padding: 10px; border-radius: 8px; margin-bottom: 5px; border-left: 3px solid #ff8c00;">
                <div style="flex: 1; overflow: hidden;">
                    <div style="color: #fff; font-weight: bold;">${track.name} ${track.votes ? `<span style="background: #1DB954; color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-left: 8px;">+${track.votes}</span>` : ''}</div>
                    <div style="color: #aaa; font-size: 12px;">${track.artist}</div>
                </div>
                <button class="btn-small" style="border: 1px solid #555; color: #aaa;" onclick="openTrackMenu(${index})">OPT</button>
            </li>`;
    });
}

function renderHistory() {
    const list = document.getElementById('history-list'); list.innerHTML = '';
    historyQueue.forEach((track) => {
        list.innerHTML += `<li class="queue-item" style="border-bottom: 1px solid #333; padding: 8px 0; color: #777;"><span>${track.name} <small>- ${track.artist}</small></span></li>`;
    });
}
