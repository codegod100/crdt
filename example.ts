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
import { createHash } from "crypto";

// Example demonstrating Beelay data transport in TypeScript
async function beelayExample() {
  console.log("=== Beelay TypeScript Example ===");

  // Create two Beelay instances
  const storage1 = new MemoryStorageAdapter();
  const signer1 = new MemorySigner();
  const alice = await Beelay.load({ storage: storage1, signer: signer1 });

  const storage2 = new MemoryStorageAdapter();
  const signer2 = new MemorySigner();
  const bob = await Beelay.load({ storage: storage2, signer: signer2 });

  console.log("Alice peer ID:", alice.peerId);
  console.log("Bob peer ID:", bob.peerId);

  // Get Bob's contact card
  const bobContactCard = await bob.createContactCard();

  // Alice creates a document shared with Bob
  const doc = await alice.createDoc({
    initialCommit: commit("initial content"),
    otherParents: [{ type: "individual", contactCard: bobContactCard }],
  });
  console.log("Document created:", doc);

  // Alice adds a commit with data
  const nextCommit = commit("synced data from Alice", [commit("initial content").hash]);
  await alice.addCommits({
    docId: doc,
    commits: [nextCommit],
  });
  console.log("Alice added commit with data");

  // Connect Alice and Bob
  connect(alice, bob);

  // Wait for sync
  await alice.waitUntilSynced(bob.peerId);
  console.log("Peers synced");

  // Bob loads the document
  const docOnBob = await bob.loadDocument(doc);
  console.log("Bob received", docOnBob.length, "commits");
  for (const item of docOnBob) {
    if (item.type === "commit") {
      console.log("Commit content:", new TextDecoder().decode(item.contents));
    }
  }

  // Clean up
  await alice.stop();
  await bob.stop();
}

function connect(left: Beelay, right: Beelay) {
  const { port1: leftToRight, port2: rightToLeft } = new MessageChannel();
  leftToRight.start();
  rightToLeft.start();

  function connectStream(stream: Stream, port: MessagePort) {
    stream.on("message", (message) => {
      port.postMessage(message);
    });
    port.onmessage = (event) => {
      stream.recv(new Uint8Array(event.data));
    };
    stream.on("disconnect", () => {
      port.close();
    });
  }

  const leftStream = left.createStream({
    direction: "connecting",
    remoteAudience: {
      type: "peerId",
      peerId: right.peerId,
    },
  });
  connectStream(leftStream, leftToRight);

  const rightStream = right.createStream({
    direction: "accepting",
  });
  connectStream(rightStream, rightToLeft);
}

function commit(contents: string, parents: string[] = []): Commit {
  const hash = createHash("sha256")
    .update(contents)
    .update(parents.join(""))
    .digest("hex");
  const contentsAsUint8Array = new Uint8Array(Buffer.from(contents, "utf-8"));
  return {
    parents,
    hash,
    contents: contentsAsUint8Array,
  };
}

// Run the example
beelayExample().catch(console.error);