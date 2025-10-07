import {
  Beelay,
  MemorySigner,
  MemoryStorageAdapter,
  type Stream,
  type Commit,
  type StorageAdapter,
  type StorageKey,
  type CommitOrBundle,
  type DocumentId,
} from "./keyhive/beelay/beelay-wasm/tests/pkg/beelay_wasm.js";

// Implement StorageAdapter using Durable Object storage
class DurableObjectStorageAdapter implements StorageAdapter {
  constructor(private storage: DurableObjectStorage) {}

  async get(key: StorageKey): Promise<Uint8Array | undefined> {
    return await this.storage.get(key);
  }

  async set(key: StorageKey, value: Uint8Array): Promise<void> {
    await this.storage.put(key, value);
  }

  async delete(key: StorageKey): Promise<void> {
    await this.storage.delete(key);
  }

  async list(prefix?: string): Promise<StorageKey[]> {
    let keys: StorageKey[] = [];
    for (let [key] of this.storage.list({ prefix })) {
      keys.push(key);
    }
    return keys;
  }
}

// Beelay handler class
class BeelayHandler {
  private beelay?: Beelay;

  async initialize() {
    if (!this.beelay) {
      // Use MemoryStorageAdapter for now
      const storage = new MemoryStorageAdapter();
      const signer = new MemorySigner();
      this.beelay = await Beelay.load({ storage, signer });
    }
    return this.beelay;
  }

  async createDoc(options: any) {
    // Convert contents to Uint8Array and compute hash
    const contents = new Uint8Array(options.initialCommit.contents);
    const hashBuffer = await crypto.subtle.digest('SHA-256', contents);
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    options.initialCommit.contents = contents;
    options.initialCommit.hash = hash;
    const beelay = await this.initialize();
    const doc = await beelay.createDoc(options);
    // Wrap: return plain JSON
    return { id: String(doc) };
  }

  async loadDocument(docId: string) {
    // Temporarily use mock with base64
    // const beelay = await this.initialize();
    // const commits = await beelay.loadDocument(docId);
    // Wrap: return plain JSON with base64 for binary
    return [{
      parents: [],
      hash: "initial",
      contents: btoa("Hello")
    }];
  }

  async addCommits(options: any) {
    const beelay = await this.initialize();
    await beelay.addCommits(options);
    return { success: true };
  }

  async createContactCard() {
    const beelay = await this.initialize();
    const card = await beelay.createContactCard();
    return { card: String(card) };
  }

  async createStream(options: any) {
    return { streamId: "placeholder" };
  }

  async waitUntilSynced(peerId: string) {
    const beelay = await this.initialize();
    await beelay.waitUntilSynced(peerId);
    return { synced: true };
  }

  async stop() {
    if (this.beelay) {
      await this.beelay.stop();
      this.beelay = undefined;
    }
  }

  async hello(name: string) {
    return `Hello, ${name}!`;
  }
}

// Worker fetch handler
export default {
  async fetch(request: Request, env: any) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();

      const handler = new BeelayHandler();

      server.addEventListener("message", async (event) => {
        try {
          console.log("Received message:", event.data);
          const msg = JSON.parse(event.data);
          const { method, params, id } = msg;
          console.log("Calling method:", method, "with params:", params);
          const result = await handler[method](...params);
          console.log("Method result:", result);
          server.send(JSON.stringify({ result, id }));
        } catch (error) {
          console.log("Error:", error);
          server.send(JSON.stringify({ error: error.message, id: msg.id }));
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: pair[1],
      });
    }

    return new Response("WebSocket required", { status: 400 });
  }
};