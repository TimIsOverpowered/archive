import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

config();

export default defineConfig({
  datasource: {
    url: process.env.META_DATABASE_URL,
  },
});
