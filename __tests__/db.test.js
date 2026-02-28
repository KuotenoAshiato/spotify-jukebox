const mongoose = require('mongoose');

jest.mock('mongoose', () => ({
  connect: jest.fn(() => Promise.resolve()),
  model: jest.fn().mockReturnValue({
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  }),
  Schema: class {
    static Types = {
      Mixed: 'Mixed',
    };
  },
}));

const { initDB, saveState, saveGlobalDb, RoomModel, GlobalDbModel } = require('../db');

describe('Database Functions', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initDB', () => {
    it('should initialize the database and load data', async () => {
      const mockGdb = {
        key: 'main',
        artists: { 'artist1': 'id1' },
        genres: { 'genre1': 'id1' },
        artistNames: { 'artist1': 'Artist One' },
        conflicts: [],
      };
      const mockRooms = [
        { roomId: 'room1', state: { key: 'value1' } },
        { roomId: 'room2', state: { key: 'value2' } },
      ];

      GlobalDbModel.findOne.mockResolvedValue(mockGdb);
      RoomModel.find.mockResolvedValue(mockRooms);

      const { sessions, globalDb } = await initDB();

      expect(GlobalDbModel.findOne).toHaveBeenCalledWith({ key: 'main' });
      expect(RoomModel.find).toHaveBeenCalled();
      expect(sessions).toEqual({
        room1: { key: 'value1' },
        room2: { key: 'value2' },
      });
      expect(globalDb).toEqual({
        artists: { 'artist1': 'id1' },
        genres: { 'genre1': 'id1' },
        artistNames: { 'artist1': 'Artist One' },
        conflicts: [],
      });
    });

    it('should handle empty database', async () => {
      GlobalDbModel.findOne.mockResolvedValue(null);
      RoomModel.find.mockResolvedValue([]);

      const { sessions, globalDb } = await initDB();

      expect(sessions).toEqual({});
      expect(globalDb).toEqual({
        artists: {},
        genres: {},
        artistNames: {},
        conflicts: [],
      });
    });
  });

  describe('saveState', () => {
    it('should save session state for each room', () => {
      const sessions = {
        room1: { key: 'value1' },
        room2: { key: 'value2' },
      };

      RoomModel.updateOne = jest.fn().mockReturnThis();
      RoomModel.catch = jest.fn();

      saveState(sessions);

      expect(RoomModel.updateOne).toHaveBeenCalledWith({ roomId: 'room1' }, { state: { key: 'value1' } }, { upsert: true });
      expect(RoomModel.updateOne).toHaveBeenCalledWith({ roomId: 'room2' }, { state: { key: 'value2' } }, { upsert: true });
    });
  });

  describe('saveGlobalDb', () => {
    it('should save the global database', () => {
      const globalDb = {
        artists: { 'artist1': 'id1' },
        genres: { 'genre1': 'id1' },
        artistNames: { 'artist1': 'Artist One' },
        conflicts: [],
      };
      
      GlobalDbModel.updateOne = jest.fn().mockReturnThis();
      GlobalDbModel.catch = jest.fn();

      saveGlobalDb(globalDb);

      expect(GlobalDbModel.updateOne).toHaveBeenCalledWith({ key: 'main' }, globalDb, { upsert: true });
    });
  });
});
