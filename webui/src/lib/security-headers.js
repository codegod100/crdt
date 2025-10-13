// Shared security headers used across the Cloudflare worker and server hooks.
/** @type {Record<string, string>} */
export const SECURITY_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Origin-Agent-Cluster': '?1'
};

/** @type {Array<[string, string]>} */
export const SECURITY_HEADER_ENTRIES = Object.entries(SECURITY_HEADERS);
