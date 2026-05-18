import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['src/index.ts', 'scripts/*.ts', 'tests/**/*.test.ts'],
  project: ['src/**/*.{ts,js}', 'scripts/**/*.{ts,js}', 'tests/**/*.{ts,js}'],
  ignore: [
    'src/db/utils/migrations.ts',
    'src/db/meta-types.ts',
    'src/db/streamer-types.ts',
    'src/services/twitch/index.ts',
    'src/services/youtube/index.ts',
    'src/services/kick/index.ts',
    'src/services/platforms/index.ts',
  ],
  ignoreBinaries: ['madge'],
  ignoreDependencies: ['fastify-plugin'],
};

export default config;
