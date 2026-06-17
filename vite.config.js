import { defineConfig } from 'vite';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(__dirname, 'Close Tracker'),
  envDir: __dirname,
});
