import {
  Beelay,
  MemorySigner,
  MemoryStorageAdapter,
} from "./test-wasm/subduction_wasm.js";

type CommitPayload = {
  hash: string;
  parents: string[];
  contents: Uint8Array;
};

async function example() {
  console.log("=== Clean Implementation with WASM ===");

  const storage = new MemoryStorageAdapter();
  const signer = new MemorySigner();
  const runtime = await Beelay.load({ storage, signer });

  const initialCommit = await makeCommit("Hello, CRDT world!", []);
  const docId = await runtime.createDoc({ initialCommit, otherParents: [] });
  console.log("Created document:", docId);

  const secondCommit = await makeCommit("Another update", [initialCommit.hash]);
  await runtime.addCommits({ docId, commits: [secondCommit] });
  console.log("Added second commit", secondCommit.hash);

  const commits = (await runtime.loadDocument(docId)) as Array<{
    type: string;
    parents?: string[];
    hash?: string;
    contents?: Uint8Array;
  }>;

  console.log(`Document has ${commits.length} entries:`);
  for (const item of commits) {
    if (item.type === "commit" && item.contents && item.hash) {
      console.log(
        `- ${item.hash.slice(0, 8)}: ${new TextDecoder().decode(item.contents)}`
      );
    }
  }

  await runtime.stop();
}

async function makeCommit(message: string, parents: string[]): Promise<CommitPayload> {
  const contents = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", contents);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return {
    contents,
    parents,
    hash,
  };
}

example().catch((error) => {
  console.error("Example failed", error);
});