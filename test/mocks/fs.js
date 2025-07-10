// Mock fs module for tests
const originalFs = jest.requireActual('fs');

// Create mock functions that can be overridden
const mocks = {
  statSync: jest.fn((path) => ({
    mtimeMs: Date.now(),
    isDirectory: () => false,
    isFile: () => true
  })),
  readFileSync: jest.fn((path, encoding) => ''),
  existsSync: jest.fn((path) => true),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => [])
};

// Export the mock with original fs methods as fallback
module.exports = {
  ...originalFs,
  ...mocks,
  promises: {
    ...originalFs.promises,
    readdir: jest.fn(async () => []),
    stat: jest.fn(async () => ({
      mtimeMs: Date.now(),
      isDirectory: () => false,
      isFile: () => true
    }))
  }
};