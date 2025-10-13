// Custom Cloudflare worker entry point
// This wraps the SvelteKit-generated worker to add security headers to all responses,
// including static assets served by the ASSETS binding

// Import the SvelteKit-generated worker
import sveltekit_worker from '../.svelte-kit/cloudflare/_worker.js';
import { SECURITY_HEADER_ENTRIES } from './lib/security-headers.js';

/**
 * Apply security headers to any response
 */
function applySecurityHeaders(response) {
	const headers = new Headers(response.headers);
	
	for (const [key, value] of SECURITY_HEADER_ENTRIES) {
		headers.set(key, value);
	}
	
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

export default {
	async fetch(request, env, ctx) {
		// Wrap the ASSETS binding to inject headers into asset responses
		if (env.ASSETS) {
			const originalAssets = env.ASSETS;
			env.ASSETS = {
				fetch: async (req) => {
					const response = await originalAssets.fetch(req);
					return applySecurityHeaders(response);
				}
			};
		}
		
		// Call the SvelteKit worker with the wrapped env
		const response = await sveltekit_worker.fetch(request, env, ctx);
		
		// Also wrap the final response (for SSR/HTML responses)
		return applySecurityHeaders(response);
	}
};
