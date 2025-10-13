# Agent Guidelines for CRDT Repository

## Build/Lint/Test Commands

### TypeScript (capnweb package)
- **Build**: `cd capnweb && npm run build` (uses tsup)
- **Test all**: `cd capnweb && npm run test` (vitest run) - may fail due to missing Playwright browsers
- **Test watch**: `cd capnweb && npm run test:watch` (vitest)
- **Single test**: `cd capnweb && npx vitest run __tests__/filename.test.ts`

### Rust (keyhive workspace)
- **Build**: `cd keyhive && cargo build`
- **Test all**: `cd keyhive && cargo test --features test_utils`
- **Lint**: `cd keyhive && cargo clippy --all-targets --features=test_utils -- -D warnings`
- **Check**: `cd keyhive && cargo check --features=test_utils`
- **Single test**: `cd keyhive && cargo test test_name --features test_utils`

### Test Notes
- **WebAssembly tests**: May fail due to fetch/network issues in test environment
- **Browser tests**: Require Playwright browsers to be installed (`pnpm exec playwright install`)
- **Focus on build/lint**: Tests may have environment-specific failures; prioritize code compilation and linting

### Important Notes
- **WebAssembly support**: Cloudflare Workers support WebAssembly; the codebase now properly bundles and initializes WASM modules
- **Environment-specific initialization**: Uses bundled WASM modules for Cloudflare Workers, import.meta.url for other environments
- **Error messages**: Improved error handling provides clear messages about WebAssembly availability
- **Build/lint focus**: Prioritize code compilation and linting; runtime execution now works in supported environments
- **WebUI full-stack**: `webui/` packages both the SvelteKit UI and the Cloudflare Worker entrypoint (`src/worker.ts`) that injects security headers, serves assets, and exposes the WebSocket RPC endpoint.
- **Wrangler configs**: Two `wrangler.toml` files exist — `beelay-worker/wrangler.toml` configures the standalone worker, while `webui/wrangler.toml` configures the SvelteKit UI deployment.
- **Durable Objects**: The WebUI worker exports `BeelayDO`; use `wrangler dev --remote` if you need the Durable Object during local development.

## Code Style Guidelines

### TypeScript
- **Imports**: Use type imports for types: `import type { Foo } from './foo'`
- **Modules**: ESNext target with NodeNext module resolution
- **Strict mode**: Enabled - all code must pass strict TypeScript checks
- **Naming**: camelCase for variables/functions, PascalCase for types/classes
- **Error handling**: Use try/catch with descriptive error messages
- **Validation logging**: When encountering invalid input or data, add logging to explain why it's invalid
- **Copyright**: Include Cloudflare copyright header on all files

### Rust
- **Edition**: 2021
- **Formatting**: rustfmt with `imports_granularity = "Crate"`
- **Linting**: Clippy warnings treated as errors
- **Error handling**: Use `thiserror` for custom error types
- **Async**: Use tokio for async operations and tests
- **Naming**: snake_case for functions/variables, PascalCase for types
- **Modules**: Descriptive module structure with clear separation of concerns

### General
- **Tests**: Write descriptive test names and use appropriate test frameworks
- **Documentation**: No inline comments unless absolutely necessary
- **Security**: Never commit secrets or expose sensitive information
- **Wrangler configs**: Two independent Worker projects live side-by-side — `beelay-worker/wrangler.toml` configures the standalone worker, while `webui/wrangler.toml` belongs to the separate SvelteKit-based web UI project.
