export default {
  displayName: 'medical_record-e2e',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testTimeout: 60000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(?:@nestjs/(?:jwt|config))/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/medical_record-e2e',
};
