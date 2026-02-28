const mongoose = require('mongoose');

// 1. Verbindung zu MongoDB herstellen
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/spotify-jukebox')
    .then(() => console.log('✅ MongoDB erfolgreich verbunden'))
    .catch(err => console.error('❌ MongoDB Fehler:', err));

// 2. Datenbank-Strukturen (Schemas) definieren
const RoomModel = mongoose.model('Room', new mongoose.Schema({
    roomId: String,
    state: mongoose.Schema.Types.Mixed
}));

const GlobalDbModel = mongoose.model('GlobalDB', new mongoose.Schema({
    key: String,
    artists: mongoose.Schema.Types.Mixed,
    genres: mongoose.Schema.Types.Mixed,
    artistNames: mongoose.Schema.Types.Mixed,
    conflicts: Array
}));

// 3. Daten beim Starten aus MongoDB laden
async function initDB() {
    let globalDb = { artists: {}, genres: {}, artistNames: {}, conflicts: [] };
    let sessions = {}; 
    try {
        const gdb = await GlobalDbModel.findOne({ key: 'main' });
        if (gdb) {
            globalDb = { 
                artists: gdb.artists || {}, 
                genres: gdb.genres || {}, 
                artistNames: gdb.artistNames || {}, 
                conflicts: gdb.conflicts || [] 
            };
        }
        const rooms = await RoomModel.find();
        rooms.forEach(room => { sessions[room.roomId] = room.state; });
        console.log("📂 Daten erfolgreich aus MongoDB geladen.");
    } catch (e) { console.error("Initialisierungsfehler:", e); }
    return { sessions, globalDb };
}

// 4. Speicher-Funktionen
function saveState(sessions) {
    for (const roomId in sessions) {
        RoomModel.updateOne({ roomId }, { state: sessions[roomId] }, { upsert: true }).catch(console.error);
    }
}

function saveGlobalDb(globalDb) {
    GlobalDbModel.updateOne({ key: 'main' }, globalDb, { upsert: true }).catch(console.error);
}

module.exports = {
    initDB,
    saveState,
    saveGlobalDb,
    RoomModel,
    GlobalDbModel
};
