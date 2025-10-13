import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
    esbuildOptions: {
      target: 'esnext'
    }
  },
  ssr: {
    target: 'node'
  }
});
