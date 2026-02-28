let globalData = null;
let currentMode = 'artist'; // 'artist' oder 'genre'
let password = localStorage.getItem('admin_pass') || '';
let availableGenres = []; // Für Autocomplete

// Event Listener für Enter-Taste im Login-Feld
const passInput = document.getElementById('admin-pass');
if (passInput) {
    passInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });
    // Fokus ins Feld setzen, wenn nicht eingeloggt
    if (!password) passInput.focus();
}

if (password) login(true);

async function login(auto = false) {
    if (!auto) password = document.getElementById('admin-pass').value.trim();
    
    try {
        const res = await fetch('/api/admin/data', {
            headers: { 'x-admin-password': password }
        });

        if (res.ok) {
            globalData = await res.json();
            localStorage.setItem('admin_pass', password);
            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('dashboard').style.display = 'block';
            renderDashboard();
        } else {
            if (!auto) {
                document.getElementById('login-error').style.display = 'block';
            }
        }
    } catch (e) {
        console.error(e);
        alert("Verbindungsfehler zum Server");
    }
}

function logout() {
    localStorage.removeItem('admin_pass');
    location.reload();
}

function renderDashboard() {
    // Stats
    document.getElementById('stat-rooms').innerText = globalData.stats.activeRooms;
    document.getElementById('stat-artists').innerText = globalData.stats.totalArtists;
    document.getElementById('stat-conflicts').innerText = globalData.stats.conflictsCount;

    updateAvailableGenres();
    setupAutocomplete(document.getElementById('edit-genre')); // Auch für das manuelle Feld
    renderRooms();
    renderConflicts();
    renderDbList();
}

function renderConflicts() {
    const container = document.getElementById('conflicts-list');
    const conflicts = globalData.globalDb.conflicts || [];

    if (conflicts.length === 0) {
        container.innerHTML = '<p style="color: #1DB954;">Keine Konflikte vorhanden.</p>';
        return;
    }

    let html = '<table><thead><tr><th>Artist</th><th>Global (Alt)</th><th>Raum (Neu)</th><th>Aktion</th></tr></thead><tbody>';
    
    conflicts.forEach(c => {
        html += `
            <tr style="background: rgba(255,255,255,0.02); border-bottom: 1px solid #333;">
                <td><strong>${c.name}</strong><br><small style="color:#777">${c.artistId}</small></td>
                <td style="color: #aaa;">${c.globalGenre}</td>
                <td style="color: #E22134; font-weight: bold;">${c.roomGenre}</td>
                <td class="actions">
                    <button class="btn-small" onclick="resolveConflict('${c.artistId}', 'keep_global')">Behalte Alt</button>
                    <button class="btn-small" style="background: #E22134;" onclick="resolveConflict('${c.artistId}', 'accept_new')">Nimm Neu</button>
                </td>
            </tr>
        `;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

async function resolveConflict(artistId, resolution) {
    if(!confirm("Bist du sicher?")) return;

    await fetch('/api/admin/resolve_conflict', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'x-admin-password': password 
        },
        body: JSON.stringify({ artistId, resolution })
    });
    
    // Reload Data
    login(true);
}

function setMode(mode) {
    currentMode = mode;
    document.getElementById('db-mode-display').innerText = mode === 'artist' ? '(Artists)' : '(Raw Genres)';
    
    // UI Updates
    if (mode === 'artist') {
        document.getElementById('lbl-id').innerText = 'Artist ID';
        document.getElementById('edit-id').placeholder = 'Spotify Artist ID';
        document.getElementById('container-name').style.display = 'block';
        document.getElementById('db-headers').innerHTML = '<th>Artist Name</th><th>Genre</th><th>ID</th><th>Aktion</th>';
    } else {
        document.getElementById('lbl-id').innerText = 'Raw Genre (Spotify)';
        document.getElementById('edit-id').placeholder = 'z.B. "german hip hop"';
        document.getElementById('container-name').style.display = 'none';
        document.getElementById('db-headers').innerHTML = '<th>Raw Genre</th><th>Ziel-Genre</th><th>-</th><th>Aktion</th>';
    }
    renderDbList();
}

function renderDbList() {
    const filter = document.getElementById('search-db').value.toLowerCase();
    const tbody = document.getElementById('db-body');
    const artists = globalData.globalDb.artists || {};
    const names = globalData.globalDb.artistNames || {};
    
    let html = '';
    let count = 0;

    if (currentMode === 'artist') {
        // Sortieren nach Namen
        const sortedIds = Object.keys(artists).sort((a,b) => {
            const nameA = (names[a] || a).toLowerCase();
            const nameB = (names[b] || b).toLowerCase();
            return nameA.localeCompare(nameB);
        });

        for (const id of sortedIds) {
            const name = names[id] || 'Unbekannt';
            const genre = artists[id];

            if (name.toLowerCase().includes(filter) || genre.toLowerCase().includes(filter) || id.includes(filter)) {
                html += `
                    <tr>
                        <td>${name}</td>
                        <td><span class="badge badge-ok">${genre}</span></td>
                        <td style="font-family: monospace; color: #777;">${id}</td>
                        <td class="actions">
                            <button class="btn-small" onclick="editEntry('${id}')">Edit</button>
                            <button class="btn-small btn-danger" onclick="deleteEntry('${id}')">Del</button>
                        </td>
                    </tr>
                `;
                count++;
                if (count > 100 && filter === '') break; 
            }
        }
    } else {
        // RAW GENRES ANZEIGEN
        const genres = globalData.globalDb.genres || {};
        const sortedRaw = Object.keys(genres).sort();

        for (const raw of sortedRaw) {
            const category = genres[raw];
            if (raw.toLowerCase().includes(filter) || category.toLowerCase().includes(filter)) {
                html += `
                    <tr>
                        <td>${raw}</td>
                        <td><span class="badge badge-ok">${category}</span></td>
                        <td style="color: #777;">-</td>
                        <td class="actions">
                            <button class="btn-small" onclick="editEntry('${raw}')">Edit</button>
                            <button class="btn-small btn-danger" onclick="deleteEntry('${raw}')">Del</button>
                        </td>
                    </tr>
                `;
                count++;
                if (count > 100 && filter === '') break;
            }
        }
    }

    if (count === 0) html = '<tr><td colspan="4">Keine Ergebnisse</td></tr>';
    tbody.innerHTML = html;
}

async function deleteEntry(id) {
    if(!confirm("Diesen Eintrag wirklich löschen?")) return;
    
    const endpoint = currentMode === 'artist' ? '/api/admin/delete_artist' : '/api/admin/delete_genre';
    const body = currentMode === 'artist' ? { artistId: id } : { rawGenre: id };

    await fetch(endpoint, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'x-admin-password': password 
        },
        body: JSON.stringify(body)
    });
    login(true);
}

async function saveEntry() {
    const id = document.getElementById('edit-id').value.trim();
    const name = document.getElementById('edit-name').value.trim();
    const genre = document.getElementById('edit-genre').value.trim();

    if (!id || !genre) {
        alert("ID/Raw Genre und Ziel-Genre sind erforderlich!");
        return;
    }

    const endpoint = currentMode === 'artist' ? '/api/admin/save_artist' : '/api/admin/save_genre';
    const body = currentMode === 'artist' 
        ? { artistId: id, name, genre } 
        : { rawGenre: id, category: genre };

    await fetch(endpoint, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'x-admin-password': password 
        },
        body: JSON.stringify(body)
    });
    
    clearEdit();
    login(true); // Daten neu laden
}

function editEntry(id) {
    document.getElementById('edit-id').value = id;
    
    if (currentMode === 'artist') {
        const artists = globalData.globalDb.artists || {};
        const names = globalData.globalDb.artistNames || {};
        document.getElementById('edit-name').value = names[id] || '';
        document.getElementById('edit-genre').value = artists[id] || '';
    } else {
        const genres = globalData.globalDb.genres || {};
        document.getElementById('edit-genre').value = genres[id] || '';
    }
    
    // Nach oben scrollen zur Eingabemaske
    document.getElementById('edit-id').scrollIntoView({ behavior: 'smooth' });
}

function clearEdit() {
    document.getElementById('edit-id').value = '';
    document.getElementById('edit-name').value = '';
    document.getElementById('edit-genre').value = '';
}

function renderRooms() {
    const container = document.getElementById('rooms-list');
    const rooms = globalData.rooms || [];

    if (rooms.length === 0) {
        container.innerHTML = '<p style="color: #777;">Keine aktiven Räume.</p>';
        return;
    }

    let html = '<table><thead><tr><th>Raum ID</th><th>Aktion</th></tr></thead><tbody>';
    rooms.forEach(roomId => {
        html += `
            <tr style="background: rgba(255,255,255,0.02); border-bottom: 1px solid #333;">
                <td><strong>${roomId}</strong></td>
                <td class="actions">
                    <button class="btn-small" style="background: #1DB954;" onclick="mergeRoom('${roomId}')">Merge</button>
                    <button class="btn-small btn-danger" onclick="closeRoom('${roomId}')">Close</button>
                </td>
            </tr>
        `;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

async function mergeRoom(roomId) {
    if(!confirm(`Daten aus Raum ${roomId} jetzt in die globale DB übernehmen?`)) return;

    try {
        const res = await fetch('/api/admin/merge_room', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password 
            },
            body: JSON.stringify({ roomId })
        });
        const data = await res.json();
        if (data.success) {
            alert(`Merge erfolgreich!\nNeu gelernt: ${data.added}\nKonflikte: ${data.conflicts}`);
            login(true);
        } else {
            alert("Fehler: " + (data.error || "Unbekannt"));
        }
    } catch(e) {
        console.error(e);
        alert("Fehler beim Mergen");
    }
}

async function closeRoom(roomId) {
    if(!confirm(`Möchtest du den Raum ${roomId} wirklich schließen? Alle Nutzer werden getrennt.`)) return;

    try {
        const res = await fetch('/api/admin/close_room', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password 
            },
            body: JSON.stringify({ roomId })
        });
        const data = await res.json();
        if (data.success) {
            login(true);
        } else {
            alert("Fehler: " + (data.error || "Unbekannt"));
        }
    } catch(e) {
        console.error(e);
        alert("Fehler beim Schließen des Raums");
    }
}

async function loadPlaylist() {
    const playlistId = document.getElementById('playlist-id').value.trim();
    if (!playlistId) return alert("Bitte Playlist ID oder Link eingeben");

    document.getElementById('playlist-results').style.display = 'block';
    document.getElementById('playlist-body').innerHTML = '<tr><td colspan="4">Lade Playlist...</td></tr>';

    try {
        const res = await fetch('/api/admin/get_playlist', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password 
            },
            body: JSON.stringify({ playlistId })
        });
        const data = await res.json();

        if (data.error) {
            document.getElementById('playlist-body').innerHTML = `<tr><td colspan="4" style="color: red;">Fehler: ${data.error}</td></tr>`;
            return;
        }

        renderPlaylistResults(data.artists);
    } catch (e) {
        console.error(e);
        document.getElementById('playlist-body').innerHTML = '<tr><td colspan="4" style="color: red;">Verbindungsfehler</td></tr>';
    }
}

function renderPlaylistResults(artists) {
    const tbody = document.getElementById('playlist-body');
    tbody.innerHTML = '';

    if (artists.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">Keine Artists gefunden.</td></tr>';
        return;
    }

    artists.forEach(artist => {
        const row = document.createElement('tr');
        row.style.cssText = "background: rgba(255,255,255,0.02); border-bottom: 1px solid #333;";
        row.innerHTML = `
            <td>
                <strong>${artist.name}</strong><br>
                <small style="color: #777;">${artist.id}</small>
            </td>
            <td>${artist.count}</td>
            <td>
                <input type="text" id="genre-${artist.id}" class="playlist-genre-input" data-artist-id="${artist.id}" data-artist-name="${artist.name.replace(/"/g, '&quot;')}" value="${artist.existingGenre}" placeholder="Genre" style="width: 100%; box-sizing: border-box; margin: 0; background: rgba(0,0,0,0.3); border: 1px solid #555; color: #ffd700;">
            </td>
            <td>
                <button class="btn-small" onclick="savePlaylistArtist('${artist.id}', '${artist.name.replace(/'/g, "\\'")}')">Save</button>
            </td>
        `;
        tbody.appendChild(row);
        
        // Autocomplete aktivieren
        setupAutocomplete(document.getElementById(`genre-${artist.id}`));
    });
}

async function savePlaylistArtist(id, name) {
    const genreInput = document.getElementById(`genre-${id}`);
    const genre = genreInput.value.trim();
    
    if (!genre) return alert("Bitte ein Genre eingeben");

    await fetch('/api/admin/save_artist', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'x-admin-password': password 
        },
        body: JSON.stringify({ artistId: id, name: name, genre: genre })
    });

    // Visuelles Feedback
    const btn = genreInput.parentElement.nextElementSibling.querySelector('button');
    const originalText = btn.innerText;
    btn.innerText = 'OK';
    
    // Zeile visuell als "erledigt" markieren
    const row = genreInput.closest('tr');
    if (row) {
        row.classList.add('saved-row');
        // Optional: Inputs deaktivieren, damit man sieht, dass es fertig ist
        // genreInput.disabled = true;
        // btn.disabled = true;
    }
    
    setTimeout(() => btn.innerText = originalText, 2000);
    
    // Optional: Global DB Liste aktualisieren, falls sichtbar
    // login(true); // Performance: Nicht bei jedem Einzel-Klick neu laden
}

async function saveAllPlaylistArtists() {
    if (!confirm("Alle ausgefüllten Genres speichern?")) return;

    const inputs = document.querySelectorAll('.playlist-genre-input');
    const artistsToSave = [];

    inputs.forEach(input => {
        const genre = input.value.trim();
        // Nur speichern, wenn ein Genre eingetragen ist UND die Zeile noch nicht gespeichert wurde
        if (genre && !input.closest('tr').classList.contains('saved-row')) {
            artistsToSave.push({
                artistId: input.dataset.artistId,
                name: input.dataset.artistName,
                genre: genre
            });
        }
    });

    if (artistsToSave.length === 0) return alert("Keine neuen Einträge zum Speichern gefunden.");

    try {
        const res = await fetch('/api/admin/save_artists_bulk', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password 
            },
            body: JSON.stringify({ artists: artistsToSave })
        });
        const data = await res.json();
        
        if (data.success) {
            alert(`${data.count} Artists erfolgreich gespeichert!`);
            // Alle gespeicherten Zeilen markieren
            inputs.forEach(input => {
                if (input.value.trim()) {
                    input.closest('tr').classList.add('saved-row');
                }
            });
            login(true); // DB neu laden
        }
    } catch (e) {
        console.error(e);
        alert("Fehler beim Massen-Speichern");
    }
}

function updateAvailableGenres() {
    const genres = new Set();
    if (globalData.globalDb.artists) Object.values(globalData.globalDb.artists).forEach(g => genres.add(g));
    if (globalData.globalDb.genres) Object.values(globalData.globalDb.genres).forEach(g => genres.add(g));
    availableGenres = Array.from(genres).sort();
}

// Custom Autocomplete Logik
function setupAutocomplete(inp) {
    if (!inp) return;
    let currentFocus;

    inp.addEventListener("input", function(e) {
        const val = this.value;
        closeAllLists();
        if (!val) return false;
        currentFocus = -1;

        const listDiv = document.createElement("DIV");
        listDiv.setAttribute("id", this.id + "autocomplete-list");
        listDiv.setAttribute("class", "autocomplete-suggestions");
        // Positionieren
        document.body.appendChild(listDiv);
        const rect = this.getBoundingClientRect();
        listDiv.style.left = rect.left + window.scrollX + "px";
        listDiv.style.top = (rect.bottom + window.scrollY) + "px";
        listDiv.style.width = rect.width + "px";

        availableGenres.forEach(genre => {
            if (genre.substr(0, val.length).toUpperCase() === val.toUpperCase()) {
                const item = document.createElement("DIV");
                item.className = "autocomplete-suggestion";
                item.innerHTML = "<strong>" + genre.substr(0, val.length) + "</strong>";
                item.innerHTML += genre.substr(val.length);
                item.innerHTML += "<input type='hidden' value='" + genre + "'>";
                item.addEventListener("click", function(e) {
                    inp.value = this.getElementsByTagName("input")[0].value;
                    closeAllLists();
                });
                listDiv.appendChild(item);
            }
        });
    });

    function closeAllLists(elmnt) {
        const x = document.getElementsByClassName("autocomplete-suggestions");
        for (let i = 0; i < x.length; i++) {
            if (elmnt != x[i] && elmnt != inp) {
                x[i].parentNode.removeChild(x[i]);
            }
        }
    }

    document.addEventListener("click", function (e) {
        closeAllLists(e.target);
    });
}