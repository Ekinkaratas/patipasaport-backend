module.exports = {
  displayName: 'dto',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // @libs/common üzerinden gelen @nestjs/jwt ve @nestjs/config v12 saf ESM.
  transformIgnorePatterns: ['/node_modules/(?!(?:@nestjs/(?:jwt|config))/)'],
  coverageDirectory: '../../coverage/libs/dto',
};
