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



async function main() {
  console.log('Client starting...');

  const rpc = newWebSocketRpcSession<BeelayApi>("ws://localhost:8787");
  rpc.onRpcBroken((error) => {
    console.error("RPC connection lost:", error);
    if (error.message && error.message.includes('URL')) {
      console.error('URL-related RPC error detected!');
      console.error('Full error:', error);
    }
  });

  try {
    console.log("Connected to worker via capnweb RPC");

    const initialCommitContents = encodeUtf8("Hello");
    const createResult = await rpc.createDoc({
      initialCommit: {
        parents: [],
        hash: "initial",
        contents: initialCommitContents,
      },
      otherParents: [],
    });

    console.log("Document created:", createResult.id);

    const commits = await rpc.loadDocument(createResult.id) as any;
    console.log("Raw commits response:", commits);

    if (Array.isArray(commits)) {
      const decodedCommits = commits.map((commit: any) => ({
        ...commit,
        contents: toUint8Array(commit.contents),
      }));

      console.log("Loaded commits:", decodedCommits);
    } else {
      console.log("Commits is not an array:", typeof commits, commits);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await disposeStub(rpc);
  }
}

void main();
