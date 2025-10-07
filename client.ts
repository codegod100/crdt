// Connect to the worker's WebSocket endpoint
// Assuming wrangler dev runs on localhost:8787
const ws = new WebSocket("ws://localhost:8787");

let nextId = 1;
const pending = new Map();

ws.onopen = () => {
  console.log("Connected to worker");
  main();
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const { result, error, id } = msg;
  const { resolve, reject } = pending.get(id);
  pending.delete(id);
  if (error) {
    reject(new Error(error));
  } else {
    resolve(result);
  }
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
};

function call(method: string, ...params: any[]) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ method, params, id }));
  });
}

async function main() {
  try {
    // Call Beelay method
    const result = await call("createDoc", {
      initialCommit: { parents: [], hash: "initial", contents: Array.from(new Uint8Array(Buffer.from("Hello"))) },
      otherParents: []
    });
    console.log("Document created:", result.id);

    // Example: Load document
    const commits = await call("loadDocument", result.id);
    // Decode base64 contents
    commits.forEach((commit: any) => {
      commit.contents = new Uint8Array(atob(commit.contents).split('').map(c => c.charCodeAt(0)));
    });
    console.log("Loaded commits:", commits);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    ws.close();
  }
}