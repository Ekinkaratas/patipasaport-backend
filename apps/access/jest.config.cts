module.exports = {
  displayName: 'access',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // @nestjs/jwt ve @nestjs/config v12 saf ESM ("type": "module") yayinlaniyor.
  // Jest varsayilan olarak node_modules'u donusturmez; bu iki paketi istisna
  // tutup ts-jest'e CommonJS'e cevirtiyoruz.
  transformIgnorePatterns: ['/node_modules/(?!(?:@nestjs/(?:jwt|config))/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/access',
};
