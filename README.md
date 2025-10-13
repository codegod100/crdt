# CRDT Demo Workspace

This repository hosts a collection of CRDT exploration projects. The primary experience lives inside `webui/`, which bundles a SvelteKit interface and the Cloudflare Worker logic that serves it — Svelte routes, asset handling, and response hardening all run inside the same worker. For lower-level experiments there is also a standalone worker in `beelay-worker/`, plus supporting libraries and tooling.

## Project Layout

- `webui/` – Full‑stack app (SvelteKit + custom Cloudflare Worker wrapper) that bundles the SPA, injects security headers for asset responses, and proxies to the CRDT RPC backend.
- `beelay-worker/` – Independent Worker that exposes the Beelay CRDT service for CLI demos or external consumers.
- `capnweb/`, `keyhive/`, `subduction/`, … – Supporting TypeScript and Rust packages that provide RPC infrastructure and CRDT implementations used by the workers.

## WebUI (Full‑Stack Worker App)

The `webui` project ships everything required to run the UI on Cloudflare Workers:

| Capability | Implementation |
| --- | --- |
| Client UI | SvelteKit, Vite build pipeline |
| Worker entrypoint | Custom `src/worker.ts` that wraps the generated SvelteKit worker, injects security headers, and routes WebSocket upgrades to the Beelay Durable Object |
| Security headers | `$lib/security-headers.js` shared between hooks, worker, and generated `_headers` file |
| Deployment bundle | `webui/wrangler.toml` targets `src/worker.ts` (which imports `.svelte-kit/cloudflare/_worker.js`) and associated assets |

### Local Development

```bash
cd webui
pnpm install

# Run the SvelteKit dev server
pnpm dev -- --host

# Preview the Worker (requires a build so `.svelte-kit` artifacts exist)
pnpm build
pnpm wrangler dev --remote

# Optional: point to a live Beelay worker
VITE_WORKER_URL=wss://your-worker.your-domain.workers.dev pnpm dev
```

For a full end-to-end experience you will also want the CRDT backend running — see the next section.

### Building & Deploying

```bash
cd webui
pnpm build          # Builds the Svelte app
pnpm wrangler deploy
```

The build step regenerates `.svelte-kit/cloudflare/_headers` so the deployed worker and Pages asset routes apply the latest security policy.

## Beelay Worker (Standalone Backend)

`beelay-worker/` contains a Cloudflare Worker that embeds the CRDT engine (Beelay + WebAssembly) and exposes a WebSocket-capable RPC interface. It is primarily used by the CLI demo and as a local backend for the `webui` app when a self-hosted endpoint is required.

```bash
cd beelay-worker
pnpm install
pnpm wrangler dev         # Local durable-object sandbox
```

## Supporting Packages

- `capnweb/` – Typed capability-RPC over WebSockets. Used by both the worker and clients.
- `keyhive/` – Rust workspace with CRDT primitives, compiled to WebAssembly for worker use.
- `subduction/`, `sqlite-wasm/`, etc. – Experimental components used by the demos.

Each package exposes its own README with deeper documentation and build instructions (`see AGENTS.md` for quick command references).

## Quick Commands

| Package | Build | Test |
| --- | --- | --- |
| `capnweb` | `cd capnweb && npm run build` | `cd capnweb && npm run test` |
| `keyhive` | `cd keyhive && cargo build` | `cd keyhive && cargo test --features test_utils` |
| `webui` | `cd webui && pnpm build` | _(Run Vite/Svelte tests as needed)_ |
| `beelay-worker` | _N/A (TypeScript Worker)_ | _Covered by integration/manual testing_ |

## Notes & Caveats

- WebSocket endpoints: the `webui` client resolves its RPC target from `VITE_WORKER_URL`; when unset it falls back to the current origin (or `ws://localhost:8787` during localhost development). In local dev run `pnpm wrangler dev --remote` so the Durable Object backing the WebSocket RPC is available.
- Playwright/browser tests are not wired up; prioritise build and type checks.
- WebAssembly modules are bundled for Cloudflare Workers, with fallbacks for other environments.

For additional guidance (including coding standards and preferred tooling), consult `AGENTS.md`.
