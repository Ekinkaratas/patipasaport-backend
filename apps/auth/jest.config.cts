module.exports = {
  displayName: 'auth',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  // @nestjs/jwt ve @nestjs/config v12 saf ESM ("type": "module") yayinlaniyor;
  // access'teki cozumun aynisi: bu paketler ts-jest ile CommonJS'e cevrilir.
  transformIgnorePatterns: ['/node_modules/(?!(?:@nestjs/(?:jwt|config))/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/auth'
};
