require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initDB, saveState, saveGlobalDb, RoomModel, GlobalDbModel } = require('./db.js');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8080/api/callback';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // Einfaches Passwort

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("FEHLER: SPOTIFY_CLIENT_ID oder SPOTIFY_CLIENT_SECRET fehlen in der .env Datei!");
} else {
    console.log(`Spotify Credentials geladen (ID: ${CLIENT_ID.substring(0, 5)}...)`);
}

let globalDb = {};
let sessions = {};

async function initialize() {
    const data = await initDB();
    if (data.sessions) Object.assign(sessions, data.sessions);
    if (data.globalDb) globalDb = data.globalDb;
}
initialize();

app.get('/api/login', (req, res) => {
    const roomId = req.query.room;
    if (!roomId) return res.status(400).send("Kein Raum angegeben");
    
    // Sicherheitsschlüssel generieren
    const code_verifier = crypto.randomBytes(32).toString('hex');
    getOrCreateRoom(roomId).codeVerifier = code_verifier; // Kurzzeitig im Server merken
    
    // Challenge berechnen
    const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        
    // Zu Spotify weiterleiten
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge_method=S256&code_challenge=${code_challenge}&scope=user-modify-playback-state%20user-read-playback-state%20user-read-currently-playing&state=${encodeURIComponent(roomId)}`;
    
    res.redirect(authUrl);
});

app.get('/api/callback', async (req, res) => {
    const code = req.query.code;
    const roomId = req.query.state;
    const room = getOrCreateRoom(roomId);
    
    if (!code || !room.codeVerifier) return res.send("Authentifizierungsfehler!");
    
    try {
        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                code_verifier: room.codeVerifier
            })
        });
        
        const data = await response.json();
        if (data.access_token) {
            room.accessToken = data.access_token;
            if (data.refresh_token) room.refreshToken = data.refresh_token;
            delete room.codeVerifier; // Aufräumen
            saveState(sessions);
            
            // Zurück zum Host-Panel leiten
            res.redirect(`/host?room=${roomId}`);
        } else {
            res.send("Spotify Fehler: " + JSON.stringify(data));
        }
    } catch (e) { res.status(500).send("Netzwerkfehler zum Spotify-Server"); }
});

// --- AUTOMATISCHER TOKEN REFRESH ---
if (process.env.NODE_ENV !== 'test') {
setInterval(async () => {
    for (const roomId in sessions) {
        const room = sessions[roomId];
        
        if (room.refreshToken) {
            try {
                // WICHTIG: Hier muss zwingend die echte Spotify API URL stehen!
                const response = await fetch("https://accounts.spotify.com/api/token", {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/x-www-form-urlencoded' 
                    },
                    // Da du PKCE nutzt, MUSS die client_id wieder in den Body!
                    body: new URLSearchParams({ 
                        client_id: CLIENT_ID,
                        client_secret: CLIENT_SECRET,
                        grant_type: 'refresh_token', 
                        refresh_token: room.refreshToken 
                    })
                });
                
                const data = await response.json();
                
                if (data.access_token) {
                    room.accessToken = data.access_token;
                    // Spotify schickt manchmal auch einen neuen Refresh-Token mit, den wir speichern
                    if (data.refresh_token) room.refreshToken = data.refresh_token;
                    
                    saveState(sessions);
                    io.to(roomId).emit('state_updated', getSafeState(roomId));
                    console.log(`Token für Raum ${roomId} erfolgreich erneuert.`);
                } else {
                    console.error(`Spotify lehnte Refresh für Raum ${roomId} ab:`, data);
                }
            } catch (e) { 
                console.error(`Refresh Fehler in Raum ${roomId}:`, e); 
            }
        }
    }
}, 45 * 60 * 1000); // Wird alle 45 Minuten ausgeführt
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- ADMIN API ---

// Middleware für Admin-Schutz
const checkAdmin = (req, res, next) => {
    const auth = req.headers['x-admin-password'];
    if (auth === ADMIN_PASSWORD) next();
    else res.status(403).json({ error: "Falsches Passwort" });
};

app.get('/api/admin/data', checkAdmin, (req, res) => {
    res.json({
        stats: {
            activeRooms: Object.keys(sessions).length,
            totalArtists: Object.keys(globalDb.artists || {}).length,
            conflictsCount: (globalDb.conflicts || []).length
        },
        rooms: Object.keys(sessions),
        globalDb: globalDb
    });
});

app.post('/api/admin/resolve_conflict', checkAdmin, express.json(), (req, res) => {
    const { artistId, resolution, customGenre } = req.body; 
    // resolution: 'keep_global', 'accept_new', 'custom'
    
    if (!globalDb.conflicts) return res.json({ success: true });

    // Konflikt finden
    const conflictIndex = globalDb.conflicts.findIndex(c => c.artistId === artistId);
    if (conflictIndex === -1) return res.status(404).json({ error: "Konflikt nicht gefunden" });
    
    const conflict = globalDb.conflicts[conflictIndex];

    if (resolution === 'accept_new') {
        globalDb.artists[artistId] = conflict.roomGenre;
    } else if (resolution === 'custom' && customGenre) {
        globalDb.artists[artistId] = customGenre;
    }
    // bei 'keep_global' machen wir nichts am Genre, löschen nur den Konflikt

    // Konflikt entfernen
    globalDb.conflicts.splice(conflictIndex, 1);
    saveGlobalDb(globalDb);
    res.json({ success: true });
});

app.post('/api/admin/delete_artist', checkAdmin, express.json(), (req, res) => {
    const { artistId } = req.body;
    if (globalDb.artists[artistId]) {
        delete globalDb.artists[artistId];
        if (globalDb.artistNames[artistId]) delete globalDb.artistNames[artistId];
        saveGlobalDb(globalDb);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Artist nicht gefunden" });
    }
});

app.post('/api/admin/save_artist', checkAdmin, express.json(), (req, res) => {
    const { artistId, name, genre } = req.body;
    if (!artistId || !genre) return res.status(400).json({ error: "ID und Genre sind Pflichtfelder" });

    globalDb.artists[artistId] = genre;
    if (name) globalDb.artistNames[artistId] = name;
    
    saveGlobalDb(globalDb);
    res.json({ success: true });
});

app.post('/api/admin/save_genre', checkAdmin, express.json(), (req, res) => {
    const { rawGenre, category } = req.body;
    if (!rawGenre || !category) return res.status(400).json({ error: "Raw Genre und Kategorie sind Pflichtfelder" });

    if (!globalDb.genres) globalDb.genres = {};
    globalDb.genres[rawGenre] = category;
    
    saveGlobalDb(globalDb);
    res.json({ success: true });
});

app.post('/api/admin/delete_genre', checkAdmin, express.json(), (req, res) => {
    const { rawGenre } = req.body;
    if (globalDb.genres && globalDb.genres[rawGenre]) {
        delete globalDb.genres[rawGenre];
        saveGlobalDb(globalDb);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Genre nicht gefunden" });
    }
});

app.post('/api/admin/save_artists_bulk', checkAdmin, express.json(), (req, res) => {
    const { artists } = req.body; // Array von { artistId, name, genre }
    if (!Array.isArray(artists)) return res.status(400).json({ error: "Ungültiges Format" });

    let count = 0;
    artists.forEach(a => {
        if (a.artistId && a.genre) {
            globalDb.artists[a.artistId] = a.genre;
            if (a.name) globalDb.artistNames[a.artistId] = a.name;
            count++;
        }
    });
    saveGlobalDb(globalDb);
    res.json({ success: true, count });
});

app.post('/api/admin/merge_room', checkAdmin, express.json(), (req, res) => {
    const { roomId } = req.body;
    const room = sessions[roomId];
    
    if (!room) return res.status(404).json({ error: "Raum nicht gefunden" });
    
    if (!globalDb.artists) globalDb.artists = {};
    if (!globalDb.artistNames) globalDb.artistNames = {};
    if (!globalDb.conflicts) globalDb.conflicts = [];
    if (!globalDb.genres) globalDb.genres = {};

    let added = 0;
    let conflicts = 0;

    if (room.db && room.db.artists) {
        for (let artistId in room.db.artists) {
            const roomGenre = room.db.artists[artistId];
            const globalGenre = globalDb.artists[artistId];
            
            if (globalGenre && globalGenre !== roomGenre) {
                const exists = globalDb.conflicts.some(c => c.artistId === artistId && c.roomGenre === roomGenre);
                if (!exists) {
                    globalDb.conflicts.push({
                        artistId: artistId,
                        name: room.db.artistNames[artistId] || 'Unbekannt',
                        globalGenre: globalGenre,
                        roomGenre: roomGenre,
                        fromRoom: roomId
                    });
                    conflicts++;
                }
            } else if (!globalGenre) {
                globalDb.artists[artistId] = roomGenre;
                if (room.db.artistNames[artistId]) {
                    globalDb.artistNames[artistId] = room.db.artistNames[artistId];
                }
                added++;
            }
        }
    }
    if (room.db && room.db.genres) {
        for (let raw in room.db.genres) {
            if (!globalDb.genres[raw]) {
                globalDb.genres[raw] = room.db.genres[raw];
            }
        }
    }
    saveGlobalDb(globalDb);
    res.json({ success: true, added, conflicts });
});

// Helper für Admin Token (Client Credentials Flow)
async function getAdminToken() {
    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`
            },
            body: new URLSearchParams({ grant_type: 'client_credentials' })
        });
        const data = await response.json();
        return data.access_token;
    } catch (e) {
        console.error("Admin Token Error:", e);
        return null;
    }
}

app.post('/api/admin/get_playlist', checkAdmin, express.json(), async (req, res) => {
    let { playlistId } = req.body;
    
    // ID aus URL extrahieren, falls nötig
    if (playlistId.includes('spotify.com')) {
        const parts = playlistId.split('/');
        const lastPart = parts[parts.length - 1];
        playlistId = lastPart.split('?')[0];
    }

    const token = await getAdminToken();
    if (!token) return res.status(500).json({ error: "Konnte keinen Spotify Token generieren" });

    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await response.json();
        
        if (data.error) return res.status(400).json({ error: data.error.message });
        if (!data.items) return res.status(400).json({ error: "Keine Tracks gefunden" });

        const artistsMap = {};
        
        data.items.forEach(item => {
            if (item.track && item.track.artists) {
                item.track.artists.forEach(artist => {
                    if (!artistsMap[artist.id]) {
                        artistsMap[artist.id] = {
                            id: artist.id,
                            name: artist.name,
                            count: 0,
                            existingGenre: globalDb.artists[artist.id] || ''
                        };
                    }
                    artistsMap[artist.id].count++;
                });
            }
        });

        const sortedArtists = Object.values(artistsMap).sort((a, b) => {
            // 1. Sortieren nach "Hat schon Genre" (Unbekannte zuerst)
            const aHas = !!a.existingGenre;
            const bHas = !!b.existingGenre;
            if (aHas !== bHas) return aHas ? 1 : -1;
            // 2. Sortieren nach Häufigkeit
            return b.count - a.count;
        });
        res.json({ artists: sortedArtists });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Fehler beim Laden der Playlist" });
    }
});

app.post('/api/admin/close_room', checkAdmin, express.json(), (req, res) => {
    const { roomId } = req.body;
    if (sessions[roomId]) {
        io.to(roomId).emit('room_closed', 'Der Raum wurde vom Administrator geschlossen.');
        delete sessions[roomId];
        RoomModel.deleteOne({ roomId: roomId }).catch(err => console.error(err));
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Raum nicht gefunden" });
    }
});

// Hilfsfunktion: Erstellt einen leeren Raum, falls er noch nicht existiert
function getOrCreateRoom(roomId) {
    if (!sessions[roomId]) {
        // Hier wird der Raum einmalig erstellt
        sessions[roomId] = {
            hostPasswordHash: null, 
            queue: [], 
            historyQueue: [], 
            db: { artists: {}, genres: {}, artistNames: {} },
            accessToken: '', 
            refreshToken: '', 
            autoDjEnabled: false, 
            fallbackCoverUrl: '',
            pendingSuggestions: [],
            rtvThreshold: 3, // Standard: 3 Votes nötig
            rtvVotedBy: [],
            genreVotedBy: {},
            showSearch: true, showSidebar: true, showQr: true, showProgress: true, enableVisualizer: true
        };
    }
    
    // Egal ob der Raum neu ist oder schon existiert, wir setzen die letzte Aktivität auf JETZT:
    sessions[roomId].lastActivity = Date.now();
    return sessions[roomId];
}

// Hilfsfunktion: Filtert geheime Daten heraus, bevor wir sie an Clients senden
function getSafeState(roomId) {
    const state = sessions[roomId];
    if (!state) return {};
    return {
        queue: state.queue,
        historyQueue: state.historyQueue,
        currentPlayingGenre: state.currentPlayingGenre || "-",
        db: state.db,
        accessToken: state.accessToken,
        autoDjEnabled: state.autoDjEnabled || false,
        hostPasswordHash: state.hostPasswordHash,
        pendingSuggestions: state.pendingSuggestions || [],
        rtvThreshold: state.rtvThreshold || 3,
        rtvVotedBy: state.rtvVotedBy || [],
        genreVotedBy: state.genreVotedBy || {},
        showSearch: state.showSearch !== false,
        showSidebar: state.showSidebar !== false,
        showQr: state.showQr !== false,
        showProgress: state.showProgress !== false,
        enableVisualizer: state.enableVisualizer !== false
    };
}

// --- ECHTZEIT-VERBINDUNG (WEBSOCKETS) ---
io.on('connection', (socket) => {
    console.log('Ein Gerät hat sich verbunden');

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        socket.roomId = roomId;
        getOrCreateRoom(roomId);
        socket.emit('init_state', getSafeState(roomId));
        console.log(`Ein Gerät ist dem Raum ${roomId} beigetreten.`);
    });

    socket.on('update_state', (newState) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return; 
        
        sessions[roomId] = { ...sessions[roomId], ...newState };
        
        // Wenn der Host den RTV-Wert so weit senkt, dass das Limit erreicht ist -> Direkt wechseln!
        if (newState.rtvThreshold && sessions[roomId].rtvVotedBy && sessions[roomId].rtvVotedBy.length >= newState.rtvThreshold) {
            triggerGenreChange(sessions[roomId]);
            saveState(sessions);
            io.to(roomId).emit('state_updated', getSafeState(roomId)); // An alle senden
        } else {
            saveState(sessions);
            // ÄNDERUNG HIER: io.to statt socket.to! So bekommt auch der Host das Update sofort zurück.
            io.to(roomId).emit('state_updated', getSafeState(roomId));
        }
    });

    // --- ZENTRALE SONG-HINZUFÜGEN LOGIK ---
    socket.on('add_track', async (trackData) => {
        const roomId = socket.roomId; // 1. Hier wird roomId definiert
        if (!roomId || !sessions[roomId]) return; // 2. Sicherheits-Check
        
        // 3. HIER ist der perfekte Platz für den Zeitstempel!
        sessions[roomId].lastActivity = Date.now();

        const room = sessions[roomId];
        
        try {
            // 1. Überprüfen, ob Artist bereits in der Raum-DB existiert
            let category = room.db.artists[trackData.artistId];
            let rawGenres = [];
            let isSuggested = false;

            if (!category) {
                
                // 2. Kein Treffer -> Spotify API nach Raw Genres fragen
                if (room.accessToken) {
                    try {
                        // WICHTIG: Hier muss exakt diese URL mit dem $ Zeichen stehen!
                        const apiUrl = `https://api.spotify.com/v1/artists/${trackData.artistId}`;
                        const res = await fetch(apiUrl, {
                            headers: { 'Authorization': 'Bearer ' + room.accessToken }
                        });
                        
                        if (res.ok) {
                            const artistData = await res.json();
                            rawGenres = artistData.genres || [];
                            
                            // 3. Raw Genres mit der lokalen Raum-DB vergleichen
                            for (let raw of rawGenres) {
                                if (room.db.genres[raw]) {
                                    category = room.db.genres[raw];
                                    break; // Erster lokaler Treffer reicht!
                                }
                            }
                        }
                    } catch (e) { 
                        console.error("Spotify API Fehler auf Server", e); 
                    }
                }

                // 4. Immer noch kein lokaler Treffer -> Globale DB anderer Nutzer prüfen
                if (!category) {
                    let suggestedGenre = null;
                    for (const otherRoomId in sessions) {
                        if (otherRoomId === roomId) continue; // Eigenen Raum überspringen
                        
                        const otherRoom = sessions[otherRoomId];
                        if (!otherRoom || !otherRoom.db) continue; 
                        
                        const otherDb = otherRoom.db;
                        
                        // Zuerst andere Artists checken
                        if (otherDb.artists && otherDb.artists[trackData.artistId]) {
                            suggestedGenre = otherDb.artists[trackData.artistId];
                            break;
                        }
                        // Dann andere Raw Genres checken
                        if (otherDb.genres) {
                            for (let raw of rawGenres) {
                                if (otherDb.genres[raw]) {
                                    suggestedGenre = otherDb.genres[raw];
                                    break;
                                }
                            }
                        }
                        if (suggestedGenre) break; // Treffer gefunden
                    }

                    // 4.1 Falls in anderen Räumen nichts gefunden, in der GLOBALEN DB schauen
                    if (!suggestedGenre && globalDb.artists && globalDb.artists[trackData.artistId]) {
                        suggestedGenre = globalDb.artists[trackData.artistId];
                    }
                    // Auch globale Raw Genres prüfen
                    if (!suggestedGenre && globalDb.genres && rawGenres.length > 0) {
                        for (let raw of rawGenres) {
                            if (globalDb.genres[raw]) {
                                suggestedGenre = globalDb.genres[raw];
                                break;
                            }
                        }
                    }

                    if (suggestedGenre) {
                        // Übergangsweise für die Warteschlange übernehmen!
                        category = suggestedGenre;
                        isSuggested = true;
                    } else {
                        // Absolut nirgends gefunden
                        category = "Genre-Unbekannt";
                    }
                }
            }

            // --- KEIN AUTOMATISCHES SPEICHERN IN DIE DB MEHR! ---
            // Wir weisen dem Song jetzt nur das ermittelte Genre zu
            trackData.genre = category;
            trackData.requestedBy = trackData.requestedBy || null; 
            if (!trackData.uniqueId) trackData.uniqueId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
            trackData.uniqueId = Date.now().toString() + Math.floor(Math.random() * 1000).toString(); // Eindeutige ID
            trackData.votes = 0;
            trackData.votedBy = [];
            // Sicherstellen, dass die Queue existiert
            if (!room.queue) room.queue = [];

            // In die Server-Queue einsortieren
            let inserted = false;
            for (let i = room.queue.length - 1; i >= 0; i--) {
                if (room.queue[i].genre === category) {
                    room.queue.splice(i + 1, 0, trackData);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) room.queue.push(trackData);

            // 5. Dem Host den Vorschlag ins Menü legen (falls globaler Vorschlag genutzt wurde)
            if (isSuggested) {
                if (!room.pendingSuggestions) room.pendingSuggestions = [];
                // Verhindern, dass derselbe Künstler doppelt landet
                if (!room.pendingSuggestions.some(s => s.artistId === trackData.artistId)) {
                    room.pendingSuggestions.push({
                        trackId: trackData.uri,
                        artistId: trackData.artistId,
                        name: trackData.name,
                        artist: trackData.artist,
                        suggestedGenre: category,
                        rawGenres: rawGenres
                    });
                }
            }

            saveState(sessions);
            
            // An ALLE Clients pushen (sodass der Song in der Warteschlange auftaucht)
            io.to(roomId).emit('state_updated', getSafeState(roomId)); 

        } catch (err) {
            console.error("Fehler beim Hinzufügen des Tracks:", err);
        }
    });

    // --- GENRE UPDATE VOM HOST ---
    socket.on('update_track_genre', async (data) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return;
        if (sessions[roomId]) sessions[roomId].lastActivity = Date.now();
        const room = sessions[roomId];
        let { artistId, artistName, newGenre, rawGenres } = data;

        // FIX: Falls der Name ein Komma enthält (z.B. "Artist A, Artist B"), versuchen wir ihn zu korrigieren
        if (artistName && artistName.includes(',')) {
            let corrected = false;

            // 1. Versuch: Spotify API (Am sichersten)
            if (room.accessToken) {
                try {
                    const res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
                        headers: { 'Authorization': 'Bearer ' + room.accessToken }
                    });
                    if (res.ok) {
                        const artistData = await res.json();
                        if (artistData.name) {
                            artistName = artistData.name;
                            corrected = true;
                        }
                    }
                } catch (e) { console.error("Fehler beim Artist-Name Lookup:", e); }
            }

            // 2. Versuch: Haben wir den Namen schon "sauber" in der Warteschlange? (Dank guest.js Fix)
            if (!corrected && room.queue) {
                const cleanTrack = room.queue.find(t => t.artistId === artistId && t.artist && !t.artist.includes(','));
                if (cleanTrack) {
                    artistName = cleanTrack.artist;
                    corrected = true;
                }
            }

            // 3. Versuch: GlobalDB Check
            if (!corrected && globalDb.artistNames && globalDb.artistNames[artistId]) {
                if (!globalDb.artistNames[artistId].includes(',')) {
                    artistName = globalDb.artistNames[artistId];
                    corrected = true;
                }
            }
        }

        // 1. In die Raum-Datenbank schreiben
        room.db.artists[artistId] = newGenre;
        if (artistName) room.db.artistNames[artistId] = artistName;
        if (rawGenres) rawGenres.forEach(raw => room.db.genres[raw] = newGenre);

        // 2. ---> HIER IST SCHRITT 1.4: Den erledigten Vorschlag löschen <---
        if (room.pendingSuggestions) {
            // Wir behalten alle Vorschläge, AUSSER dem, den wir gerade bearbeitet haben (artistId)
            room.pendingSuggestions = room.pendingSuggestions.filter(s => s.artistId !== artistId);
        }

        // 3. Warteschlange umsortieren
        const tracksToMove = room.queue.filter(t => t.artistId === artistId);
        room.queue = room.queue.filter(t => t.artistId !== artistId); 
        
        tracksToMove.forEach(track => {
            track.genre = newGenre;
            let inserted = false;
            for (let i = room.queue.length - 1; i >= 0; i--) {
                if (room.queue[i].genre === newGenre) {
                    room.queue.splice(i + 1, 0, track);
                    inserted = true; break;
                }
            }
            if (!inserted) room.queue.push(track);
        });

        // 4. Speichern und alle Geräte updaten
        saveState(sessions);
        io.to(roomId).emit('state_updated', getSafeState(roomId));
    });

    socket.on('remove_suggestion', (artistId) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return;
        sessions[roomId].lastActivity = Date.now();
        const room = sessions[roomId];
        
        if (room.pendingSuggestions) {
            room.pendingSuggestions = room.pendingSuggestions.filter(s => s.artistId !== artistId);
            saveState(sessions);
            io.to(roomId).emit('state_updated', getSafeState(roomId));
        }
    });

    socket.on('clear_all_suggestions', () => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return;
        
        sessions[roomId].pendingSuggestions = [];
        saveState(sessions);
        io.to(roomId).emit('state_updated', getSafeState(roomId));
    });

    // --- VOTING SYSTEM (mit Anti-Cheat) ---
    socket.on('upvote_track', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId] || !sessions[roomId].queue) return;
        
        sessions[roomId].lastActivity = Date.now();
        const room = sessions[roomId];

        // Wir entpacken die Daten vom Gast (Abwärtskompatibel, falls noch alte Tabs offen sind)
        const uniqueId = data.uniqueId || data; 
        const deviceId = data.deviceId || socket.id;

        // 1. Finde den Song in der Warteschlange
        const trackIndex = room.queue.findIndex(t => (t.uniqueId === uniqueId) || (t.uri === uniqueId));
        if (trackIndex === -1) return; // Song nicht mehr da

        const track = room.queue[trackIndex];
        
        // 2. Anti-Cheat: Hat DIESES GERÄT schon gevotet?
        if (!track.votedBy) track.votedBy = [];
        if (track.votedBy.includes(deviceId)) return;

        // 3. Vote hinzufügen
        track.votes = (track.votes || 0) + 1;
        track.votedBy.push(deviceId); // Hier speichern wir jetzt die Geräte-ID!

        // 4. Nur innerhalb DIESES Genre-Blocks umsortieren
        const genre = track.genre;
        
        let startIndex = trackIndex;
        while (startIndex > 0 && room.queue[startIndex - 1].genre === genre) {
            startIndex--;
        }
        
        let endIndex = trackIndex;
        while (endIndex < room.queue.length - 1 && room.queue[endIndex + 1].genre === genre) {
            endIndex++;
        }

        const block = room.queue.slice(startIndex, endIndex + 1);
        block.sort((a, b) => (b.votes || 0) - (a.votes || 0));

        room.queue.splice(startIndex, block.length, ...block);

        saveState(sessions);
        io.to(roomId).emit('state_updated', getSafeState(roomId));
    });

    socket.on('logout_spotify', () => {
        const roomId = socket.roomId;
        if (roomId && sessions[roomId]) {
            sessions[roomId].accessToken = '';
            sessions[roomId].refreshToken = '';
            saveState(sessions);
            io.to(roomId).emit('state_updated', getSafeState(roomId));
        }
    });
    socket.on('vote_genre', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return;
        const room = sessions[roomId];
        const { genre, deviceId } = data;

        if (!room.genreVotedBy) room.genreVotedBy = {};
        
        // Verhindern, dass man für mehrere Genres gleichzeitig stimmt
        for (let g in room.genreVotedBy) {
            room.genreVotedBy[g] = room.genreVotedBy[g].filter(id => id !== deviceId);
        }

        if (!room.genreVotedBy[genre]) room.genreVotedBy[genre] = [];
        room.genreVotedBy[genre].push(deviceId);

        sortQueueByGenreVotes(room);

        saveState(sessions); 
        io.to(roomId).emit('state_updated', getSafeState(roomId));
    });

    socket.on('vote_rtv', (deviceId) => {
        const roomId = socket.roomId;
        if (!roomId || !sessions[roomId]) return;
        const room = sessions[roomId];

        if (!room.rtvVotedBy) room.rtvVotedBy = [];
        
        if (!room.rtvVotedBy.includes(deviceId)) {
            room.rtvVotedBy.push(deviceId);
        }

        const threshold = room.rtvThreshold || 3;
        if (room.rtvVotedBy.length >= threshold) {
            triggerGenreChange(room); // BÄM! Wechsel auslösen
        }

        saveState(sessions); 
        io.to(roomId).emit('state_updated', getSafeState(roomId));
    });

    socket.on('disconnect', () => {
        if (socket.roomId)
            console.log(`Gerät aus Raum ${socket.roomId} getrennt`);
    });
});
if (process.env.NODE_ENV !== 'test') {
setInterval(() => {
    const now = Date.now();
    for (const roomId in sessions) {
        const room = sessions[roomId];
        
        // 15 Minuten = 15 * 60 * 1000 Millisekunden
        if (room.lastActivity && (now - room.lastActivity > 15 * 60 * 1000)) {
            console.log(`Raum ${roomId} wird wegen Inaktivität geschlossen.`);
            
            // 1. Daten in die globale DB mergen
            if (room.db && room.db.artists) {
                for (let artistId in room.db.artists) {
                    const roomGenre = room.db.artists[artistId];
                    const globalGenre = globalDb.artists[artistId];
                    
                    // Konflikt prüfen: Künstler existiert bereits mit ANDEREM Genre
                    if (globalGenre && globalGenre !== roomGenre) {
                        globalDb.conflicts.push({
                            artistId: artistId,
                            name: room.db.artistNames[artistId] || 'Unbekannt',
                            globalGenre: globalGenre,
                            roomGenre: roomGenre,
                            fromRoom: roomId
                        });
                    } else {
                        // Kein Konflikt -> Einfach übernehmen
                        globalDb.artists[artistId] = roomGenre;
                        if (room.db.artistNames[artistId]) {
                            globalDb.artistNames[artistId] = room.db.artistNames[artistId];
                        }
                    }
                }
            }
            // 2. Raw Genres in die globale DB mergen
            if (room.db && room.db.genres) {
                if (!globalDb.genres) globalDb.genres = {};
                for (let raw in room.db.genres) {
                    if (!globalDb.genres[raw]) {
                        globalDb.genres[raw] = room.db.genres[raw];
                    }
                }
            }
            saveGlobalDb(globalDb);            
            // 3. Allen Clients Bescheid geben und Raum löschen
            io.to(roomId).emit('room_closed', 'Die Jukebox wurde wegen 15 Minuten Inaktivität beendet.');
            delete sessions[roomId];
            RoomModel.deleteOne({ roomId: roomId }).catch(err => console.error(err)); // Löscht den Raum aus der MongoDB
        }
    }
    saveState(sessions); // Speichert die restlichen aktiven Räume
}, 60 * 1000); // Prüft jede Minute
}
// --- GENRE VOTING & RTV LOGIK ---

    function sortQueueByGenreVotes(room) {
        if (!room.queue || room.queue.length === 0) return;

        // 1. Preserve the current genre block at the top.
        const currentGenre = room.queue[0].genre;
        const currentGenreTracks = [];
        const otherTracks = [];
        room.queue.forEach(track => {
            if (track.genre === currentGenre) {
                currentGenreTracks.push(track);
            } else {
                otherTracks.push(track);
            }
        });

        if (otherTracks.length === 0) return; // Only one genre, nothing to sort.

        // 2. Get vote counts for the other genres.
        const voteCounts = {};
        if (room.genreVotedBy) {
            for (const genre in room.genreVotedBy) {
                voteCounts[genre] = room.genreVotedBy[genre].length;
            }
        }

        // 3. Group the remaining tracks by genre.
        const tracksByGenre = new Map();
        otherTracks.forEach(track => {
            if (!tracksByGenre.has(track.genre)) {
                tracksByGenre.set(track.genre, []);
            }
            tracksByGenre.get(track.genre).push(track);
        });

        // 4. Sort the genres based on vote count.
        const sortedGenres = [...tracksByGenre.keys()].sort((a, b) => (voteCounts[b] || 0) - (voteCounts[a] || 0));
        
        // 5. Reconstruct the queue.
        const newQueue = [...currentGenreTracks];
        sortedGenres.forEach(genre => {
            newQueue.push(...tracksByGenre.get(genre));
        });

        room.queue = newQueue;
    }
    
    // Hilfsfunktion: Führt den Genre-Wechsel aus
    function triggerGenreChange(room) {
        if (!room.queue || room.queue.length === 0) return;
        const currentGenre = room.queue[0].genre;
        
        let winningGenre = null;
        let maxVotes = -1;
        
        // Gewinner-Genre ermitteln
        if (room.genreVotedBy) {
            for (let g in room.genreVotedBy) {
                if (g === currentGenre) continue; // Aktuelles Genre ignorieren
                let votes = room.genreVotedBy[g].length;
                if (votes > maxVotes) { maxVotes = votes; winningGenre = g; }
            }
        }

        // Falls niemand gevotet hat -> Nächstes Genre in der Schlange nehmen
        if (!winningGenre || maxVotes === 0) {
            const nextTrack = room.queue.find(t => t.genre !== currentGenre);
            if (nextTrack) winningGenre = nextTrack.genre;
        }

        // Warteschlange umsortieren (Gewinner-Block ganz nach oben)
        if (winningGenre) {
            const winningTracks = room.queue.filter(t => t.genre === winningGenre);
            const otherTracks = room.queue.filter(t => t.genre !== winningGenre);
            room.queue = [...winningTracks, ...otherTracks];
            room.currentPlayingGenre = winningGenre;
        }

        // Votes nach Wechsel zurücksetzen!
        room.rtvVotedBy = [];
        room.genreVotedBy = {};
    }

    
const PORT = 8080;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
      console.log(`Jukebox Backend läuft auf Port ${PORT}`);
      console.log(`Host-Panel: http://127.0.0.1:${PORT}/host`);
      console.log(`Jukebox-Display: http://127.0.0.1:${PORT}/jukebox`);
      console.log(`Admin-Panel: http://127.0.0.1:${PORT}/admin`);
  });
}

module.exports = { app, server, io, sessions };