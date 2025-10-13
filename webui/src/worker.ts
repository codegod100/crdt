import sveltekit_worker from '../.svelte-kit/cloudflare/_worker.js';
import { SECURITY_HEADER_ENTRIES } from './lib/security-headers.js';
import beelayBackend, { BeelayDO as BaseBeelayDO } from '../../beelay-worker/worker';

export class BeelayDO extends BaseBeelayDO {
	constructor(state: any, env: any) {
		super(state, env);
	}
}

const UPGRADE_HEADER = 'websocket';

const applySecurityHeaders = (response: Response): Response => {
	const headers = new Headers(response.headers);

	for (const [key, value] of SECURITY_HEADER_ENTRIES) {
		headers.set(key, value);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
};

export default {
	async fetch(request: Request, env: any, ctx: unknown): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade')?.toLowerCase();
		if (upgradeHeader === UPGRADE_HEADER) {
			return beelayBackend.fetch(request, env);
		}

		if (env.ASSETS && typeof env.ASSETS === 'object' && env.ASSETS !== null && 'fetch' in env.ASSETS) {
			const originalAssets = env.ASSETS as { fetch: (req: Request) => Promise<Response> };
			env.ASSETS = {
				async fetch(req: Request) {
					const assetResponse = await originalAssets.fetch(req);
					return applySecurityHeaders(assetResponse);
				}
			};
		}

		const response = await (sveltekit_worker as any).fetch(request, env, ctx);
		return applySecurityHeaders(response);
	}
};
