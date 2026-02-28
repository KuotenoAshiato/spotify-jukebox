const request = require('supertest');
const http = require('http');
const { Server } = require('socket.io');
const Client = require('socket.io-client');
const { app, server, io, sessions } = require('../server');

jest.mock('../db', () => ({
  initDB: jest.fn(() => Promise.resolve({ sessions: {}, globalDb: {} })),
  saveState: jest.fn(),
  saveGlobalDb: jest.fn(),
  RoomModel: {},
  GlobalDbModel: {},
}));

describe('HTTP API', () => {
  let testServer;
  beforeAll((done) => {
    testServer = server.listen(0, done);
  });

  afterAll((done) => {
    io.close();
    testServer.close(done);
  });

  describe('GET /api/login', () => {
    it('should redirect to Spotify authorization URL', async () => {
      const response = await request(server).get('/api/login?room=test-room');
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://accounts.spotify.com/authorize');
    });

    it('should return 400 if no room is specified', async () => {
      const response = await request(server).get('/api/login');
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/callback', () => {
    beforeEach(() => {
      sessions['test-room'] = {
        hostPasswordHash: null,
        queue: [],
        historyQueue: [],
        db: { artists: {}, genres: {}, artistNames: {} },
        accessToken: '',
        refreshToken: '',
        autoDjEnabled: false,
        fallbackCoverUrl: '',
        pendingSuggestions: [],
        rtvThreshold: 3,
        rtvVotedBy: [],
        genreVotedBy: {},
        showSearch: true, showSidebar: true, showQr: true, showProgress: true, enableVisualizer: true,
        codeVerifier: 'test_code_verifier'
      };
      sessions['test-room'].lastActivity = Date.now();
    });
    it('should exchange authorization code for access token and redirect to host panel', async () => {
      const mockFetch = jest.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve({
          json: () => Promise.resolve({ access_token: 'test_access_token', refresh_token: 'test_refresh_token' }),
        })
      );

      const response = await request(server).get('/api/callback?code=test_code&state=test-room');

      expect(mockFetch).toHaveBeenCalledWith('https://accounts.spotify.com/api/token', expect.any(Object));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/host?room=test-room');
      expect(sessions['test-room'].accessToken).toBe('test_access_token');
      expect(sessions['test-room'].refreshToken).toBe('test_refresh_token');

      mockFetch.mockRestore();
    });

    it('should return an error message if authentication fails', async () => {
      const mockFetch = jest.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve({
          json: () => Promise.resolve({ error: 'invalid_grant' }),
        })
      );

      const response = await request(server).get('/api/callback?code=test_code&state=test-room');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Spotify Fehler:');

      mockFetch.mockRestore();
    });

    it('should return an error message if no code is provided', async () => {
      const response = await request(server).get('/api/callback?state=test-room');
      expect(response.status).toBe(200);
      expect(response.text).toBe('Authentifizierungsfehler!');
    });
  });

  describe('Socket.IO Events', () => {
    let clientSocket;
    let port;

    beforeEach((done) => {
      port = testServer.address().port;
      clientSocket = new Client(`http://localhost:${port}`);
      clientSocket.on('connect', done);
    });

    afterEach(() => {
      if (clientSocket.connected) {
        clientSocket.close();
      }
      jest.restoreAllMocks();
    });

    it('should join a room and receive init_state', (done) => {
      const roomId = 'test-room-socket-join';
      clientSocket.emit('join_room', roomId);
      clientSocket.on('init_state', (state) => {
        expect(state).toHaveProperty('queue');
        expect(sessions[roomId]).toBeDefined();
        done();
      });
    });

    it('should add a track to the queue', (done) => {
      const roomId = 'test-room-socket-add';
      sessions[roomId] = {
        queue: [],
        db: { artists: {}, genres: {}, artistNames: {} },
        accessToken: 'valid_token',
        lastActivity: Date.now()
      };

      jest.spyOn(global, 'fetch').mockImplementation(() => 
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ genres: [] })
        })
      );

      clientSocket.emit('join_room', roomId);
      
      clientSocket.once('init_state', () => {
        clientSocket.emit('add_track', {
          uri: 'spotify:track:123',
          name: 'Test Track',
          artist: 'Test Artist',
          artistId: 'artist1',
          cover: 'cover.jpg'
        });
      });

      clientSocket.on('state_updated', (state) => {
        const track = state.queue.find(t => t.uri === 'spotify:track:123');
        if (track) {
          expect(track.name).toBe('Test Track');
          expect(track.genre).toBe('Genre-Unbekannt');
          done();
        }
      });
    });

    it('should upvote a track', (done) => {
      const roomId = 'test-room-socket-vote';
      const trackId = 'track_unique_id';
      sessions[roomId] = {
        queue: [{
          uniqueId: trackId,
          name: 'Test Track',
          votes: 0,
          votedBy: [],
          genre: 'Pop'
        }],
        db: { artists: {}, genres: {}, artistNames: {} },
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);
      
      clientSocket.once('init_state', () => {
        clientSocket.emit('upvote_track', { uniqueId: trackId, deviceId: 'device_1' });
      });

      clientSocket.on('state_updated', (state) => {
        const track = state.queue.find(t => t.uniqueId === trackId);
        if (track && track.votes === 1) {
          expect(track.votedBy).toContain('device_1');
          done();
        }
      });
    });

    it('should update room state', (done) => {
      const roomId = 'test-room-update';
      sessions[roomId] = {
        autoDjEnabled: false,
        lastActivity: Date.now()
      };
      
      clientSocket.emit('join_room', roomId);
      clientSocket.once('init_state', () => {
        clientSocket.emit('update_state', { autoDjEnabled: true });
      });

      clientSocket.on('state_updated', (state) => {
        if (state.autoDjEnabled === true) {
          expect(sessions[roomId].autoDjEnabled).toBe(true);
          done();
        }
      });
    });

    it('should handle genre voting and sort queue', (done) => {
      const roomId = 'test-room-genre-vote';
      sessions[roomId] = {
        queue: [
          { uniqueId: '1', genre: 'Rock', name: 'Rock Song' },
          { uniqueId: '2', genre: 'Pop', name: 'Pop Song' },
          { uniqueId: '3', genre: 'Jazz', name: 'Jazz Song' }
        ],
        genreVotedBy: {},
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);
      
      clientSocket.once('init_state', () => {
        clientSocket.emit('vote_genre', { genre: 'Jazz', deviceId: 'dev1' });
      });

      clientSocket.on('state_updated', (state) => {
        if (state.genreVotedBy['Jazz'] && state.genreVotedBy['Jazz'].length === 1) {
          expect(state.queue[0].genre).toBe('Rock');
          expect(state.queue[1].genre).toBe('Jazz');
          expect(state.queue[2].genre).toBe('Pop');
          done();
        }
      });
    });

    it('should trigger genre change when RTV threshold is reached', (done) => {
      const roomId = 'test-room-rtv';
      sessions[roomId] = {
        queue: [
          { uniqueId: '1', genre: 'Rock', name: 'Rock Song' },
          { uniqueId: '2', genre: 'Pop', name: 'Pop Song' }
        ],
        rtvThreshold: 2,
        rtvVotedBy: [],
        genreVotedBy: { 'Pop': ['dev3'] },
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);

      clientSocket.once('init_state', () => {
        clientSocket.emit('vote_rtv', 'dev1');
      });

      let votesReceived = 0;
      clientSocket.on('state_updated', (state) => {
        if (state.rtvVotedBy.length === 1 && votesReceived === 0) {
          votesReceived = 1;
          clientSocket.emit('vote_rtv', 'dev2');
        } else if (state.rtvVotedBy.length === 0 && votesReceived === 1) {
          expect(state.queue[0].genre).toBe('Pop');
          done();
        }
      });
    });

    it('should allow host to update track genre', (done) => {
      const roomId = 'test-room-host-update';
      sessions[roomId] = {
        queue: [{ uniqueId: '1', artistId: 'a1', genre: 'OldGenre', name: 'Song' }],
        db: { artists: { 'a1': 'OldGenre' }, genres: {}, artistNames: {} },
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);
      
      clientSocket.once('init_state', () => {
        clientSocket.emit('update_track_genre', {
          artistId: 'a1',
          artistName: 'Artist',
          newGenre: 'NewGenre',
          rawGenres: []
        });
      });

      clientSocket.on('state_updated', (state) => {
        if (state.db.artists['a1'] === 'NewGenre') {
          expect(state.queue[0].genre).toBe('NewGenre');
          done();
        }
      });
    });

    it('should remove a suggestion', (done) => {
      const roomId = 'test-room-suggestion';
      sessions[roomId] = {
        pendingSuggestions: [{ artistId: 'a1', name: 'Artist' }],
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);

      clientSocket.once('init_state', () => {
        clientSocket.emit('remove_suggestion', 'a1');
      });

      clientSocket.on('state_updated', (state) => {
        if (state.pendingSuggestions.length === 0) {
          done();
        }
      });
    });

    it('should clear tokens on logout', (done) => {
      const roomId = 'test-room-logout';
      sessions[roomId] = {
        accessToken: 'token',
        refreshToken: 'refresh',
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);
      clientSocket.once('init_state', () => {
        clientSocket.emit('logout_spotify');
      });

      clientSocket.on('state_updated', (state) => {
        if (state.accessToken === '') {
          expect(sessions[roomId].accessToken).toBe('');
          expect(sessions[roomId].refreshToken).toBe('');
          done();
        }
      });
    });

    it('should group tracks by genre (insert into existing block)', (done) => {
      const roomId = 'test-room-queue-grouping';
      sessions[roomId] = {
        queue: [
          { uniqueId: '1', genre: 'Rock', name: 'Rock 1', artistId: 'r1' },
          { uniqueId: '2', genre: 'Pop', name: 'Pop 1', artistId: 'p1' }
        ],
        db: { artists: { 'r2': 'Rock' }, genres: {}, artistNames: {} }, // Genre bereits bekannt
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);
      
      clientSocket.once('init_state', () => {
        clientSocket.emit('add_track', {
          uri: 'spotify:track:rock2',
          name: 'Rock 2',
          artist: 'Rocker',
          artistId: 'r2', // Passt zum DB-Eintrag
          cover: ''
        });
      });

      clientSocket.on('state_updated', (state) => {
        if (state.queue.length === 3) {
          // Erwartung: Rock 1, Rock 2, Pop 1 (Rock 2 wird in den Rock-Block einsortiert)
          expect(state.queue[0].name).toBe('Rock 1');
          expect(state.queue[1].name).toBe('Rock 2');
          expect(state.queue[2].name).toBe('Pop 1');
          done();
        }
      });
    });

    it('should prevent duplicate votes from same device', (done) => {
      const roomId = 'test-room-anti-cheat';
      const trackId = 't1';
      sessions[roomId] = {
        queue: [{ uniqueId: trackId, name: 'Song', votes: 0, votedBy: [], genre: 'Pop' }],
        db: { artists: {}, genres: {}, artistNames: {} },
        lastActivity: Date.now()
      };

      clientSocket.emit('join_room', roomId);

      clientSocket.once('init_state', () => {
        // Erster Vote
        clientSocket.emit('upvote_track', { uniqueId: trackId, deviceId: 'device_A' });
      });

      let updates = 0;
      clientSocket.on('state_updated', (state) => {
        updates++;
        const track = state.queue.find(t => t.uniqueId === trackId);
        
        if (updates === 1) {
            expect(track.votes).toBe(1);
            // Versuch erneut zu voten mit gleicher ID
            clientSocket.emit('upvote_track', { uniqueId: trackId, deviceId: 'device_A' });
            // Manuelles Update triggern, um zu prüfen, ob sich nichts geändert hat
            clientSocket.emit('update_state', { showSearch: true });
        } else if (updates === 2) {
            // Sollte immer noch 1 sein
            expect(track.votes).toBe(1);
            done();
        }
      });
    });

    it('should learn genre from another room (Global DB simulation)', (done) => {
      const roomId = 'test-room-global-lookup';
      const otherRoomId = 'other-active-room';
      
      // Setup aktueller Raum
      sessions[roomId] = {
        queue: [],
        db: { artists: {}, genres: {}, artistNames: {} },
        lastActivity: Date.now()
      };

      // Setup anderer Raum, der den Künstler kennt
      sessions[otherRoomId] = {
        db: { 
            artists: { 'known_artist': 'Techno' }, 
            genres: {}, 
            artistNames: {} 
        }
      };

      // Mock fetch Fehler (damit Fallback greift)
      jest.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve({ ok: false }));

      clientSocket.emit('join_room', roomId);

      clientSocket.once('init_state', () => {
        clientSocket.emit('add_track', {
          uri: 'spotify:track:techno1',
          name: 'Techno Song',
          artist: 'DJ',
          artistId: 'known_artist', // Existiert in otherRoomId
          cover: ''
        });
      });

      clientSocket.on('state_updated', (state) => {
        if (state.queue.length > 0) {
            expect(state.queue[0].genre).toBe('Techno');
            // Prüfen, ob es als Vorschlag für den Host markiert wurde
            expect(state.pendingSuggestions).toHaveLength(1);
            expect(state.pendingSuggestions[0].suggestedGenre).toBe('Techno');
            done();
        }
      });
    });
  });
});
