import init, { initSync } from "./test-wasm/subduction_wasm.js";
import wasmModule from "./test-wasm/subduction_wasm_bg.wasm";
import {
  Beelay,
  MemorySigner,
  MemoryStorageAdapter,
} from "./test-wasm/subduction_wasm.js";
import { RpcTarget, newWebSocketRpcSession } from "./capnweb/dist/index.js";

type StorageKey = string[];

interface StorageAdapter {
  load(key: StorageKey): Promise<Uint8Array | undefined>;
  loadRange(prefix: StorageKey): Promise<Map<StorageKey, Uint8Array>>;
  save(key: StorageKey, data: Uint8Array): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  listOneLevel(prefix: StorageKey): Promise<StorageKey[]>;
}

type CommitMessage = {
  type: string;
  parents?: string[];
  hash?: string;
  contents?: Uint8Array;
  [key: string]: unknown;
};

// Declare WebSocketPair for TypeScript
declare const WebSocketPair: any;

// Check WebAssembly support on module load
checkWebAssemblySupport();

// Also log WebAssembly initialization status
console.log('WebAssembly module imported, will initialize lazily on first use');

// Lazy initialization of WebAssembly module
let wasmInitialized = false;
let wasmInitPromise: Promise<void> | null = null;

// Check if we're in an environment that supports WebAssembly
function checkWebAssemblySupport() {
  const isCFWorker = typeof navigator === 'object' && navigator?.userAgent === 'Cloudflare-Workers';
  const hasImportMetaUrl = typeof import.meta !== 'undefined' && typeof import.meta.url === 'string';

  if (isCFWorker && !hasImportMetaUrl) {
    console.log('⚠️  Cloudflare Worker environment detected without import.meta.url support');
    console.log('WebAssembly will be disabled - this is expected behavior');
  }

  return { isCFWorker, hasImportMetaUrl };
}

async function ensureWasmInitialized() {
  if (wasmInitialized) return;

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      console.log('=== WebAssembly Initialization ===');

      try {
        // Check if we're in Cloudflare Workers
        const isCFWorker = typeof navigator === 'object' && navigator?.userAgent === 'Cloudflare-Workers';
        console.log('Environment:', isCFWorker ? 'Cloudflare Worker' : 'Other');

        // In Cloudflare Workers, use the bundled WASM module directly
        if (isCFWorker) {
          console.log('Using bundled WASM module for Cloudflare Workers');
          // The WASM module is imported and bundled by Wrangler
          initSync(wasmModule);
          console.log('✅ WebAssembly initialized successfully with bundled module');
        } else {
          // In other environments (like Node.js), try the standard initialization
          console.log('Using standard WebAssembly initialization');
          const hasImportMetaUrl = typeof import.meta !== 'undefined' && typeof import.meta.url === 'string';
          if (hasImportMetaUrl) {
            await init();
            console.log('✅ WebAssembly initialized successfully with import.meta.url');
          } else {
            // Fallback: try to use the bundled module even in non-CF environments
            console.log('Falling back to bundled WASM module');
            initSync(wasmModule);
            console.log('✅ WebAssembly initialized successfully with fallback bundled module');
          }
        }

        wasmInitialized = true;
        console.log('✅ WebAssembly initialization complete');

      } catch (error) {
        console.error('❌ WebAssembly initialization failed:', error);
        console.error('This means WebAssembly features will not be available');

        // Set a flag to indicate WASM is disabled
        (globalThis as any).__WASM_DISABLED__ = true;
        wasmInitialized = true; // Mark as initialized to avoid retrying

        console.log('Application will continue without WebAssembly features');
      }
    })();
  }

  await wasmInitPromise;
}

// Implement StorageAdapter using Durable Object storage
const KEY_DELIM = "|";

function encodeStorageKey(key: StorageKey): string {
  if (key.length === 0) {
    return "";
  }
  return key.map((part) => `${part.length}:${part}`).join(KEY_DELIM);
}

function encodeStoragePrefix(prefix: StorageKey): string | undefined {
  if (prefix.length === 0) {
    return undefined;
  }
  const encoded = encodeStorageKey(prefix);
  return encoded.length ? `${encoded}${KEY_DELIM}` : undefined;
}

function decodeStorageKey(encoded: string): StorageKey {
  if (!encoded) {
    return [];
  }

  const parts: string[] = [];
  let index = 0;
  while (index < encoded.length) {
    const colonIndex = encoded.indexOf(":", index);
    if (colonIndex === -1) {
      throw new Error(`Invalid encoded storage key: ${encoded}`);
    }

    const lengthPart = encoded.slice(index, colonIndex);
    const length = Number(lengthPart);
    if (!Number.isFinite(length)) {
      throw new Error(`Invalid segment length in storage key: ${lengthPart}`);
    }

    const start = colonIndex + 1;
    const end = start + length;
    const segment = encoded.slice(start, end);
    parts.push(segment);
    index = end;

    if (index === encoded.length) {
      break;
    }

    if (encoded[index] !== KEY_DELIM) {
      throw new Error(`Invalid storage key separator in: ${encoded}`);
    }
    index += 1;
  }

  return parts;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  throw new Error("Unexpected stored value type; expected binary data");
}

async function listEntries(storage: any, prefix: string | undefined) {
  if (prefix === undefined) {
    return await storage.list();
  }
  return await storage.list({ prefix });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

class DurableObjectStorageAdapter implements StorageAdapter {
  constructor(private storage: any) {}

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const stored = await this.storage.get(encodeStorageKey(key));
    return stored === undefined ? undefined : toUint8Array(stored);
  }

  async loadRange(prefix: StorageKey): Promise<Map<StorageKey, Uint8Array>> {
    const result = new Map<StorageKey, Uint8Array>();
    const exactKey = encodeStorageKey(prefix);
    const exact = await this.storage.get(exactKey);
    if (exact !== undefined) {
      result.set(prefix, toUint8Array(exact));
    }

    const prefixString = encodeStoragePrefix(prefix);
    const entries = await listEntries(this.storage, prefixString);
    for (const [rawKey, rawValue] of entries) {
      const decodedKey = decodeStorageKey(rawKey);
      result.set(decodedKey, toUint8Array(rawValue));
    }

    return result;
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.storage.put(encodeStorageKey(key), data);
  }

  async remove(key: StorageKey): Promise<void> {
    await this.storage.delete(encodeStorageKey(key));
  }

  async listOneLevel(prefix: StorageKey): Promise<StorageKey[]> {
    const results: StorageKey[] = [];
    const seen = new Set<string>();
    const prefixString = encodeStoragePrefix(prefix);
    const entries = await listEntries(this.storage, prefixString);

    for (const [rawKey] of entries) {
      const decoded = decodeStorageKey(rawKey);
      if (decoded.length <= prefix.length) {
        continue;
      }
      const child = decoded.slice(0, prefix.length + 1);
      const encodedChild = encodeStorageKey(child);
      if (!seen.has(encodedChild)) {
        seen.add(encodedChild);
        results.push(child);
      }
    }

    return results;
  }
}

// function encodeStoragePrefix(prefix: StorageKey): string | undefined {
//   if (prefix.length === 0) {
//     return undefined;
//   }
//   const encoded = encodeStorageKey(prefix);
//   return encoded.length ? `${encoded}${KEY_DELIM}` : undefined;
// }

// function decodeStorageKey(encoded: string): StorageKey {
//   if (!encoded) {
//     return [];
//   }

//   const parts: string[] = [];
//   let index = 0;
//   while (index < encoded.length) {
//     const colonIndex = encoded.indexOf(":", index);
//     if (colonIndex === -1) {
//       throw new Error(`Invalid encoded storage key: ${encoded}`);
//     }

//     const lengthPart = encoded.slice(index, colonIndex);
//     const length = Number(lengthPart);
//     if (!Number.isFinite(length)) {
//       throw new Error(`Invalid segment length in storage key: ${lengthPart}`);
//     }

//     const start = colonIndex + 1;
//     const end = start + length;
//     const segment = encoded.slice(start, end);
//     parts.push(segment);
//     index = end;

//     if (index === encoded.length) {
//       break;
//     }

//     if (encoded[index] !== KEY_DELIM) {
//       throw new Error(`Invalid storage key separator in: ${encoded}`);
//     }
//     index += 1;
//   }

//   return parts;
// }

// function toUint8Array(value: unknown): Uint8Array {
//   if (value instanceof Uint8Array) {
//     return value;
//   }

//   if (value instanceof ArrayBuffer) {
//     return new Uint8Array(value);
//   }

//   if (ArrayBuffer.isView(value)) {
//     const view = value as ArrayBufferView;
//     return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
//   }

//   throw new Error("Unexpected stored value type; expected binary data");
// }

// async function listEntries(storage: any, prefix: string | undefined) {
//   if (prefix === undefined) {
//     return await storage.list();
//   }
//   return await storage.list({ prefix });
// }

// class DurableObjectStorageAdapter implements StorageAdapter {
//   constructor(private storage: any) {}

//   async load(key: StorageKey): Promise<Uint8Array | undefined> {
//     const stored = await this.storage.get(encodeStorageKey(key));
//     return stored === undefined ? undefined : toUint8Array(stored);
//   }

//   async loadRange(prefix: StorageKey): Promise<Map<StorageKey, Uint8Array>> {
//     const result = new Map<StorageKey, Uint8Array>();
//     const exactKey = encodeStorageKey(prefix);
//     const exact = await this.storage.get(exactKey);
//     if (exact !== undefined) {
//       result.set(prefix, toUint8Array(exact));
//     }

//     const prefixString = encodeStoragePrefix(prefix);
//     const entries = await listEntries(this.storage, prefixString);
//     for (const [rawKey, rawValue] of entries) {
//       const decodedKey = decodeStorageKey(rawKey);
//       result.set(decodedKey, toUint8Array(rawValue));
//     }

//     return result;
//   }

//   async save(key: StorageKey, data: Uint8Array): Promise<void> {
//     await this.storage.put(encodeStorageKey(key), data);
//   }

//   async remove(key: StorageKey): Promise<void> {
//     await this.storage.delete(encodeStorageKey(key));
//   }

//   async listOneLevel(prefix: StorageKey): Promise<string[][]> {
//     const results: StorageKey[] = [];
//     const seen = new Set<string>();
//     const prefixString = encodeStoragePrefix(prefix);
//     const entries = await listEntries(this.storage, prefixString);

//     for (const [rawKey] of entries) {
//       const decoded = decodeStorageKey(rawKey);
//       if (decoded.length <= prefix.length) {
//         continue;
//       }
//       const child = decoded.slice(0, prefix.length + 1);
//       const encodedChild = encodeStorageKey(child);
//       if (!seen.has(encodedChild)) {
//         seen.add(encodedChild);
//         results.push(child);
//       }
//     }

//     return results;
//   }
// }

// Beelay handler class
type BeelayFactory = () => Promise<{ storage: StorageAdapter; signer: MemorySigner }>;

type ClientRegistration = {
  target: any;
  originalTarget: any;
  docId?: string;
};

function toBase64(data: Uint8Array): string {
  if (data.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

class BeelayHandler extends RpcTarget {
  private beelay?: Beelay;
  private beelayPromise?: Promise<Beelay>;
  private readonly clientTargets = new Set<ClientRegistration>();

  constructor(private readonly factory?: BeelayFactory) {
    super();
  }

  sendToAll?: (message: any) => void;

  private async getBeelay() {
    if (this.beelay) {
      return this.beelay;
    }

    if (!this.beelayPromise) {
      this.beelayPromise = (async () => {
        // Ensure WebAssembly module is initialized (may be skipped in some environments)
        await ensureWasmInitialized();

        // Check if WebAssembly is disabled
        if ((globalThis as any).__WASM_DISABLED__) {
          console.log('WebAssembly disabled - cannot create Beelay instance');
          throw new Error('WebAssembly not available in this environment - Beelay requires WebAssembly');
        }

        const { storage, signer } = this.factory
          ? await this.factory()
          : { storage: new MemoryStorageAdapter(), signer: new MemorySigner() };
        const instance = await Beelay.load({ storage, signer });
        this.beelay = instance;
        return instance;
      })();
    }

    return this.beelayPromise;
  }

  private serializeCommit(commit: any) {
    let contents: Uint8Array;
    const value = commit.contents;
    if (value instanceof Uint8Array) {
      contents = value;
    } else if (value instanceof ArrayBuffer) {
      contents = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      contents = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    } else if (typeof value === "string") {
      const decoded = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      contents = decoded;
    } else if (Array.isArray(value)) {
      contents = new Uint8Array(value);
    } else {
      throw new Error("Unsupported commit contents type for serialization");
    }

    return {
      parents: commit.parents,
      hash: commit.hash,
      contents: toBase64(contents)
    };
  }

  private async broadcast(event: any, docId?: string) {
    console.log('📣 broadcast', {
      type: event?.type,
      docId,
      totalTargets: this.clientTargets.size,
      filteredTargets: [...this.clientTargets].filter((registration) => !docId || !registration.docId || registration.docId === docId).length,
    });

    if (this.clientTargets.size === 0 && !this.sendToAll) {
      console.log('ℹ️ broadcast: no registered targets');
    }

    if (this.sendToAll) {
      this.sendToAll(event);
    }

    for (const registration of [...this.clientTargets]) {
      if (docId && registration.docId && registration.docId !== docId) {
        continue;
      }

      try {
        const result = registration.target.handleServerEvent(event);
        if (result && typeof result.then === "function") {
          await result;
        }
      } catch (error) {
        console.error("Error delivering event to client target:", error);
        if (typeof registration.target?.[Symbol.dispose] === "function") {
          try {
            registration.target[Symbol.dispose]();
          } catch (disposeError) {
            console.warn('broadcast dispose failed', disposeError);
          }
        }
        this.clientTargets.delete(registration);
        console.log('🧹 removed client target after delivery failure', {
          remaining: this.clientTargets.size,
          docId: registration.docId,
        });
      }
    }
  }

  async registerClientTarget(target: any, docId?: string) {
    let retainedTarget = target;
    try {
      if (typeof target?.dup === "function") {
        retainedTarget = target.dup();
      } else {
        const rawSymbol = Object.getOwnPropertySymbols(target).find((symbol) => symbol.description === "realStub");
        if (rawSymbol) {
          const rawStub = (target as any)[rawSymbol];
          if (typeof rawStub?.dup === "function") {
            retainedTarget = rawStub.dup();
          }
        }
      }
    } catch (error) {
      console.warn("registerClientTarget: failed to duplicate stub", error);
    }

    const registration: ClientRegistration = { target: retainedTarget, originalTarget: target, docId };
    this.clientTargets.add(registration);
    console.log('✅ registered client target', {
      total: this.clientTargets.size,
      docId,
    });

    if (retainedTarget && typeof retainedTarget.onRpcBroken === "function") {
      retainedTarget.onRpcBroken(() => {
        if (typeof registration.target?.[Symbol.dispose] === "function") {
          try {
            registration.target[Symbol.dispose]();
          } catch (disposeError) {
            console.warn('onRpcBroken dispose failed', disposeError);
          }
        }
        this.clientTargets.delete(registration);
      });
    }

    return { success: true };
  }

  async unregisterClientTarget(target: any, docId?: string) {
    for (const registration of this.clientTargets) {
      if (registration.originalTarget === target && (!docId || registration.docId === docId)) {
        if (typeof registration.target?.[Symbol.dispose] === "function") {
          try {
            registration.target[Symbol.dispose]();
          } catch (disposeError) {
            console.warn('unregisterClientTarget dispose failed', disposeError);
          }
        }
        this.clientTargets.delete(registration);
        console.log('🧹 unregistered client target', { total: this.clientTargets.size, docId });
        break;
      }
    }
    return { success: true };
  }

  async createDoc(options: any) {
    // Convert contents to Uint8Array and compute hash
    const contents = new Uint8Array(options.initialCommit.contents);
    const hashBuffer = await crypto.subtle.digest('SHA-256', contents);
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    options.initialCommit.contents = contents;
    options.initialCommit.hash = hash;
    const beelay = await this.getBeelay();
    const doc = await beelay.createDoc(options);
    // Send direct message to all clients
  await this.broadcast({ type: 'docCreated', id: String(doc) }, String(doc));
    // Wrap: return plain JSON
    return { id: String(doc) };
  }

  async loadDocument(docId: string) {
    const beelay = await this.getBeelay();
    const commits = (await beelay.loadDocument(docId)) as CommitMessage[] | undefined;

    // Convert commits to plain JSON with base64 for binary contents
    if (!commits) return [];

    return commits.map((commit) => {
      if (
        commit.type === "commit" &&
        Array.isArray(commit.parents) &&
        typeof commit.hash === "string" &&
        commit.contents instanceof Uint8Array
      ) {
        return {
          parents: commit.parents,
          hash: commit.hash,
          contents: encodeBase64(commit.contents),
        };
      }
      // Handle bundle types if needed
      return commit;
    });
  }

  async addCommits(options: any) {
    const beelay = await this.getBeelay();
    await beelay.addCommits(options);
    await this.broadcast(
      {
        type: 'commitsAdded',
        docId: options.docId,
        commits: options.commits.map((commit: any) => this.serializeCommit(commit))
      },
      options.docId
    );
    return { success: true };
  }

  async addWorkerCommit(docId: string, content: string) {
    const beelay = await this.getBeelay();

    // Get current document state to create a proper commit
    const currentCommits = await beelay.loadDocument(docId);
    if (!currentCommits || currentCommits.length === 0) {
      throw new Error('Document not found or empty');
    }

    // Find the latest commit hash
    const latestCommit = currentCommits[currentCommits.length - 1];
    if (latestCommit.type !== 'commit') {
      throw new Error('Latest item is not a commit');
    }

    // Create a new commit (use TextEncoder instead of Buffer)
    const contents = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', contents) as ArrayBuffer;
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const newCommit = {
      parents: [latestCommit.hash],
      hash,
      contents
    };

    await beelay.addCommits({ docId, commits: [newCommit] });
    await this.broadcast(
      {
        type: 'commitAdded',
        docId,
        commit: this.serializeCommit(newCommit)
      },
      docId
    );
    return { success: true, commitHash: hash };
  }

  async createContactCard() {
    const beelay = await this.getBeelay();
    const card = await beelay.createContactCard();
    return { card: String(card) };
  }

  async createStream(options: any) {
    return { streamId: "placeholder" };
  }

  async waitUntilSynced(peerId: string) {
    const beelay = await this.getBeelay();
    await beelay.waitUntilSynced(peerId);
    return { synced: true };
  }

  async stop() {
    if (this.beelay) {
      await this.beelay.stop();
      this.beelay = undefined;
      this.beelayPromise = undefined;
    }
  }

  async hello(name: string) {
    return `Hello, ${name}!`;
  }

  async [Symbol.asyncDispose]() {
    await this.stop();
  }
}

export class BeelayDO {
  private readonly handler: BeelayHandler;

  constructor(private readonly state: any, private readonly env: any) {
    // Note: WebAssembly initialization will happen lazily in BeelayHandler.getBeelay()
    this.handler = new BeelayHandler(async () => {
      // Ensure WebAssembly module is initialized before creating signer
      await ensureWasmInitialized();

      // Check if WebAssembly is disabled
      if ((globalThis as any).__WASM_DISABLED__) {
        console.log('WebAssembly disabled in Durable Object - cannot create signer');
        throw new Error('WebAssembly not available - cannot create MemorySigner');
      }

      return {
        storage: new DurableObjectStorageAdapter(this.state.storage),
        signer: new MemorySigner(),
      };
    });

    // Legacy broadcast path is unused when clients register RPC targets
    this.handler.sendToAll = undefined;
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const webSocketPair = new WebSocketPair();
      const client = webSocketPair[0];
      const server = webSocketPair[1];

      server.accept();
      newWebSocketRpcSession(server, this.handler);

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as any);
    }

    return new Response("WebSocket required", { status: 400 });
  }
}

// Worker fetch handler
export default {
  async fetch(request: Request, env: any) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const id = env.BEELAY_DO.idFromName("global");
      const stub = env.BEELAY_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("WebSocket required", { status: 400 });
  }
};
