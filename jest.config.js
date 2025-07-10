/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  testTimeout: 30000,
  transformIgnorePatterns: [
    'node_modules/(?!(p-queue|chalk|ora|boxen|string-width|emoji-regex|ansi-regex|strip-ansi|wrap-ansi|p-limit|yocto-queue|eventemitter3|cli-spinners|log-update|ansi-escapes|onetime|mimic-fn|restore-cursor|signal-exit|is-interactive|is-unicode-supported|bl|readable-stream|string_decoder|cli-boxes|widest-line|camelcase|type-fest|ansi-align|cli-cursor|inquirer|inquirer-autocomplete-prompt)/)'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^p-queue$': '<rootDir>/test/mocks/p-queue.js',
    '^chalk$': '<rootDir>/test/mocks/chalk.js',
    '^ora$': '<rootDir>/test/mocks/ora.js',
    '^inquirer$': '<rootDir>/test/mocks/inquirer.js',
    '^inquirer-autocomplete-prompt$': '<rootDir>/test/mocks/inquirer-autocomplete-prompt.js',
    '^fuzzy$': '<rootDir>/test/mocks/fuzzy.js',
    '^boxen$': '<rootDir>/test/mocks/boxen.js',
    '^figlet$': '<rootDir>/test/mocks/figlet.js',
  },
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};