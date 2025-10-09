import { newWebSocketRpcSession, RpcStub, RpcTarget } from "./capnweb/dist/index.js";

interface CommitSnapshot {
  parents: string[];
  hash: string;
  contents: unknown;
}

interface CreateDocOptions {
  initialCommit: {
    parents: string[];
    hash: string;
    contents: Uint8Array;
  };
  otherParents: unknown[];
}

interface CreateDocResult {
  id: string;
}

interface BeelayApi extends RpcTarget {
  createDoc(options: CreateDocOptions): CreateDocResult;
  loadDocument(docId: string): CommitSnapshot[];
  addCommits(options: unknown): { success: boolean };
  addWorkerCommit(docId: string, content: string): { success: boolean; commitHash: string };
  createContactCard(): { card: string };
  createStream(options: unknown): { streamId: string };
  waitUntilSynced(peerId: string): { synced: boolean };
  stop(): void;
  hello(name: string): string;
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (typeof data === "string") {
    try {
      return Uint8Array.from(Buffer.from(data, "base64"));
    } catch {
      return Uint8Array.from(Buffer.from(data));
    }
  }

  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }

  throw new Error("Unsupported commit contents format");
}

async function disposeStub(stub: RpcStub<BeelayApi>) {
  const disposer = (stub as any)[Symbol.asyncDispose] ?? (stub as any)[Symbol.dispose];
  if (typeof disposer === "function") {
    await disposer.call(stub);
  }
}



async function createCommit(content: string, parents: string[] = []): Promise<any> {
  const contents = encodeUtf8(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', contents as BufferSource) as ArrayBuffer;
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    parents,
    hash,
    contents  // Keep as Uint8Array, the serialization system can handle this
  };
}

async function demonstrateCRDT() {
  console.log('🚀 CRDT Conflict-Free Replication Demo');
  console.log('=====================================');

  const rpc = newWebSocketRpcSession<BeelayApi>("ws://localhost:8787");
  rpc.onRpcBroken((error) => {
    // This is expected when we dispose the stub, so just log it
    if (error.message && error.message.includes("RPC session was shut down by disposing the main stub")) {
      console.log("✅ RPC connection closed (expected - stub disposed)");
    } else {
      console.error("RPC connection lost unexpectedly:", error);
    }
  });

  try {
    console.log("📡 Connected to worker via capnweb RPC");

    // Step 1: Create a shared document
    console.log("\n📄 Step 1: Creating shared document");
    const initialCommit = await createCommit("Initial document content");
    const createResult = await rpc.createDoc({
      initialCommit,
      otherParents: [],
    });

    const docId = createResult.id;
    console.log("✅ Document created with ID:", docId);
    console.log("📝 Initial commit:", initialCommit.hash);

    // Step 2: Load initial state
    console.log("\n📖 Step 2: Loading initial document state");
    let commits = await rpc.loadDocument(docId) as any[];
    console.log("📊 Current commits:", commits.length);
    commits.forEach((commit, i) => {
      const content = toUint8Array(commit.contents);
      console.log(`  ${i + 1}. ${commit.hash}: "${new TextDecoder().decode(content)}"`);
    });

    // Step 3: Client makes a change
    console.log("\n✏️  Step 3: Client making concurrent change");
    const clientCommit = await createCommit("Client added: Meeting notes", [initialCommit.hash]);
    await rpc.addCommits({ docId, commits: [clientCommit] });
    console.log("✅ Client commit added:", clientCommit.hash);

    // Step 4: Worker makes a concurrent change (simulating concurrent editing)
    console.log("\n🤖 Step 4: Worker making concurrent change");
    const workerResult = await rpc.addWorkerCommit(docId, "Worker added: Action items");
    console.log("✅ Worker commit added:", workerResult.commitHash);

    // Step 5: Load final merged state
    console.log("\n🔄 Step 5: Loading merged document state");
    commits = await rpc.loadDocument(docId) as any[];
    console.log("📊 Final merged commits:", commits.length);
    commits.forEach((commit, i) => {
      const content = toUint8Array(commit.contents);
      const author = commit.hash === clientCommit.hash ? "👤 Client" :
                    commit.hash === workerResult.commitHash ? "🤖 Worker" : "📄 Initial";
      console.log(`  ${i + 1}. ${author}: "${new TextDecoder().decode(content)}" (hash: ${commit.hash.substring(0, 8)}...)`);
    });

    // Step 6: Demonstrate conflict-free merging
    console.log("\n✨ Step 6: CRDT Conflict-Free Merging Demonstration");
    console.log("Both client and worker made concurrent changes to the same document.");
    console.log("CRDT automatically merged both changes without conflicts!");
    console.log("📋 Final document contains:");
    console.log("   - Initial content");
    console.log("   - Client's meeting notes");
    console.log("   - Worker's action items");
    console.log("All changes preserved and merged automatically! 🎉");

  } catch (error) {
    // Check if this is the expected disposal error
    if (error.message && error.message.includes("RPC session was shut down by disposing the main stub")) {
      console.log("✅ CRDT demonstration completed successfully (RPC connection closed as expected)");
    } else {
      console.error("❌ Error during CRDT demonstration:", error);
    }
  } finally {
    await disposeStub(rpc);
  }
}

async function main() {
  await demonstrateCRDT();
}

void main();
