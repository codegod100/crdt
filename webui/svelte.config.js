import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // Use our custom worker that adds security headers to ASSETS responses
      platformProxy: {
        environment: undefined
      }
    })
  }
};

export default config;
