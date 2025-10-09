# CRDT Conflict-Free Replication Demo

This project demonstrates Conflict-Free Replicated Data Types (CRDTs) using a Sedimentree-based Commit Graph CRDT implementation. It showcases automatic conflict resolution for collaborative document editing.

## Architecture

- **CRDT Type**: Sedimentree-based Commit Graph CRDT with SHA-256 hashing
- **Backend**: Cloudflare Worker with WebAssembly CRDT operations
- **RPC**: capnweb for efficient WebSocket communication
- **Frontend**: React-based web UI for interactive demonstrations
- **CLI Client**: Node.js client for command-line demonstrations

## Components

### Worker (`worker.ts`)
Cloudflare Worker that handles CRDT operations using Beelay WebAssembly modules:
- Document creation and management
- Commit operations with automatic merging
- Durable Object-based storage
- WebSocket RPC endpoint

### Client (`client.ts`)
Node.js command-line client that demonstrates CRDT functionality:
- Creates shared documents
- Performs concurrent edits
- Shows automatic conflict-free merging

### Web UI (`webui/`)
Browser-based interface for interactive CRDT demonstrations:
- Real-time logging of operations
- Visual demonstration of concurrent editing
- WebSocket connection to worker backend

## Setup & Usage

### Prerequisites
- Node.js and pnpm
- Cloudflare Workers CLI (`wrangler`)

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Start Cloudflare Worker
```bash
# Terminal 1: Start the worker
pnpm run client  # This runs the worker via wrangler dev
```

### 3. Run CLI Demo
```bash
# Terminal 2: Run the Node.js client demo
pnpm run client
```

### 4. Run Web UI Demo
```bash
# Terminal 3: Start the web interface
cd webui && pnpm dev
# Open http://localhost:5173 in your browser
```

## CRDT Demonstration

The demo shows a collaborative document editing scenario:

1. **Document Creation**: Initial document with base content
2. **Concurrent Editing**: Client and worker make simultaneous changes
3. **Automatic Merging**: CRDT resolves conflicts without data loss
4. **Final State**: All changes preserved in merged document

### Key Features Demonstrated
- **Conflict-Free**: No edit conflicts or data loss
- **Commutative**: Operations can be applied in any order
- **Associative**: Grouping operations doesn't affect results
- **Idempotent**: Duplicate operations are safe

## Technical Details

### Sedimentree CRDT
- **Structure**: Directed Acyclic Graph (DAG) of commits
- **Integrity**: SHA-256 content hashing
- **Merging**: Ancestry-based automatic conflict resolution
- **Storage**: Binary content with hash verification

### WebAssembly Integration
- Environment-aware initialization (bundled for Cloudflare Workers)
- Fallback handling for environments without `import.meta.url`
- Graceful degradation when WebAssembly unavailable

### RPC Communication
- capnweb for object-capability RPC
- WebSocket transport for real-time communication
- Promise pipelining for efficient batch operations

## Development

### Build Commands
```bash
# Build TypeScript (capnweb)
cd capnweb && npm run build

# Build Rust (keyhive workspace)
cd keyhive && cargo build

# Build Web UI
cd webui && pnpm build
```

### Test Commands
```bash
# Test capnweb
cd capnweb && npm run test

# Test keyhive
cd keyhive && cargo test --features test_utils
```

## Next Steps

Potential enhancements for the CRDT system:
- Real-time multi-client synchronization
- Document encryption and access control
- Complex CRDT operations (deletes, renames)
- Performance optimization for large documents
- Additional CRDT types and data structures