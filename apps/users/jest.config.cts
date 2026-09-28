module.exports = {
  displayName: 'users',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  // @nestjs/config v12 saf ESM ("type": "module") yayinlaniyor; PrismaService
  // uzerinden zincire giriyor. auth/access'teki cozumun aynisi: ts-jest ile
  // CommonJS'e cevrilir.
  transformIgnorePatterns: ['/node_modules/(?!(?:@nestjs/(?:jwt|config))/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/users'
};
