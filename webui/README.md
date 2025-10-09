# CRDT Web UI with SQLite Persistence

A React-based web interface for demonstrating Conflict-Free Replicated Data Types (CRDTs) with local SQLite database persistence using SQLite WASM.

## Features

- **Real-time CRDT Demonstration**: Interactive demo showing conflict-free merging of concurrent document edits
- **SQLite WASM Persistence**: Local database storage using SQLite compiled to WebAssembly
- **Origin Private File System (OPFS)**: Persistent storage that survives browser restarts
- **WebSocket RPC**: Uses capnweb for efficient communication with the Cloudflare Worker backend
- **Document Management**: Save, load, and view CRDT documents with full commit history
- **Live Logging**: Real-time display of CRDT operations and merge results

## Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Start the Cloudflare Worker backend:**
   ```bash
   cd ..
   pnpm run client  # or start the worker separately
   ```

3. **Start the development server:**
   ```bash
   pnpm dev
   ```

4. **For production build with proper headers:**
   ```bash
   pnpm build
   pnpm exec http-server dist --cors --coop --coep
   ```

5. **Open your browser** to the displayed URL (usually `http://localhost:5173` for dev, `http://localhost:8080` for production)

## Browser Requirements

For full functionality with persistent storage, your browser must support:

- **Cross-Origin Opener Policy (COOP)** and **Cross-Origin Embedder Policy (COEP)** headers
- **Origin Private File System (OPFS)** API
- **SharedArrayBuffer** (requires COOP/COEP headers)

### COOP/COEP Headers

The app requires special HTTP headers for OPFS (persistent SQLite storage):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Development:**
- Vite dev server is configured with these headers
- May not work in all browsers due to header timing issues

**Production:**
- Use `pnpm serve` which uses `http-server` with `--coop --coep` flags
- Or deploy to a server that can set these headers

**Fallback:** If OPFS is unavailable, the app automatically falls back to in-memory storage (data won't persist between sessions).

### Troubleshooting OPFS Issues

If you see errors about SharedArrayBuffer or OPFS not being available:

1. **Check Browser Support:** OPFS requires Chrome 109+ or Safari 16.4+
2. **Verify Headers:** Ensure your server sends the required COOP/COEP headers
3. **Development:** Vite dev server should set headers automatically
4. **Production:** Use a server that supports COOP/COEP headers

**Manual Testing:** You can test if headers are working by checking the Network tab in DevTools - look for the COOP/COEP headers in responses.

## Configuration

The WebSocket URL for connecting to the CRDT worker can be configured via the `.env` file:

```env
VITE_WORKER_URL=ws://localhost:8787
```

## How It Works

The demo shows a collaborative document editing scenario with persistent storage:

1. **SQLite Initialization**: Sets up local SQLite database using WASM
2. **Document Creation**: Creates initial document with base content, saved to SQLite
3. **Concurrent Editing**: Client and worker make simultaneous changes via WebSocket RPC
4. **Commit Persistence**: All commits are saved to local SQLite database
5. **Automatic Merging**: CRDT resolves conflicts without data loss
6. **Document History**: View complete commit history for any saved document

### Key Features Demonstrated
- **Conflict-Free**: No edit conflicts or data loss
- **Persistent Storage**: Documents survive browser restarts (with OPFS)
- **Offline Capability**: SQLite operations work without network connectivity
- **Commutative**: Operations can be applied in any order
- **Associative**: Grouping operations doesn't affect results
- **Idempotent**: Duplicate operations are safe

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Database**: SQLite WASM with OPFS for persistence
- **RPC**: capnweb for WebSocket-based remote procedure calls
- **Backend**: Cloudflare Worker with WebAssembly CRDT implementation
- **CRDT**: Sedimentree-based commit graph with SHA-256 hashing and automatic conflict resolution

## Database Schema

The SQLite database contains two main tables:

```sql
-- Documents table
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_modified INTEGER NOT NULL
);

-- Commits table
CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  parents TEXT NOT NULL, -- JSON array of parent hashes
  hash TEXT NOT NULL,
  contents BLOB NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents (id)
);
```

## Data Persistence

- **OPFS Mode**: Full persistence across browser sessions (Chrome 109+, Safari 16.4+)
- **Fallback Mode**: In-memory storage when OPFS unavailable
- **Export/Import**: Documents can be exported as SQLite database files
- **Multi-tab Sync**: Changes in one tab are visible in others (same origin)

## Current Status

The app will show initialization messages in the browser console:
- ✅ SQLite database initialized successfully with OPFS persistence (when headers work)
- ⚠️ Data will not persist between browser sessions (fallback mode)
- 💡 To enable OPFS persistence: Server must send COOP/COEP headers
