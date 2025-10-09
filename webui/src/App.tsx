import { useState, useRef, useEffect } from 'react'
import { newWebSocketRpcSession, RpcStub } from 'capnweb'
import { sqliteService, type CRDTDoc, type CRDTCommit } from './sqliteService'
import './App.css'

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

interface BeelayApi {
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
      // Browser-compatible base64 decoding
      return Uint8Array.from(atob(data), c => c.charCodeAt(0));
    } catch {
      return new TextEncoder().encode(data);
    }
  }

  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }

  throw new Error("Unsupported commit contents format");
}

async function createCommit(content: string, parents: string[] = []): Promise<any> {
  const contents = encodeUtf8(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', contents as BufferSource) as ArrayBuffer;
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    parents,
    hash,
    contents
  };
}

function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [documents, setDocuments] = useState<CRDTDoc[]>([]);
  const [sqliteInitialized, setSqliteInitialized] = useState(false);
  const [documentId, setDocumentId] = useState('');
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const rpcRef = useRef<RpcStub<BeelayApi> | null>(null);
  const syncIntervalRef = useRef<number | null>(null);

  // Initialize SQLite on component mount
  useEffect(() => {
    const initSQLite = async () => {
      try {
        await sqliteService.initialize();
        setSqliteInitialized(true);
        addLog('✅ SQLite database initialized');

        // Load existing documents
        try {
          const docs = await sqliteService.getAllDocuments();
          setDocuments(docs);
          if (docs.length > 0) {
            addLog(`📁 Found ${docs.length} existing document(s)`);
          }
        } catch (error) {
          addLog(`⚠️  Could not load documents: ${error}`);
        }
      } catch (error) {
        addLog(`❌ Failed to initialize SQLite: ${error}`);
      }
    };

    initSQLite();
  }, []);

  const addLog = (message: string) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const disposeStub = async (stub: RpcStub<BeelayApi>) => {
    try {
      // Try to dispose using the capnweb disposal method
      if (typeof (stub as any)[(Symbol as any).dispose] === "function") {
        (stub as any)[(Symbol as any).dispose]();
      }
    } catch (error) {
      // Ignore disposal errors
      console.log("Disposal completed");
    }
  };

  const demonstrateCRDT = async () => {
    if (isRunning || !sqliteInitialized) return;

    setIsRunning(true);
    setConnectionStatus('connecting');
    clearLogs();

    addLog('🚀 CRDT Conflict-Free Replication Demo with Multi-Client Sync');
    addLog('=============================================================');

    try {
      // Connect to the worker
      const workerUrl = import.meta.env.VITE_WORKER_URL || "ws://localhost:8787";
      const rpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      rpcRef.current = rpc;

      rpc.onRpcBroken((error) => {
        if (error.message && error.message.includes("RPC session was shut down by disposing the main stub")) {
          addLog("✅ RPC connection closed (expected - stub disposed)");
          setConnectionStatus('disconnected');
        } else {
          addLog(`❌ RPC connection lost unexpectedly: ${error.message}`);
          setConnectionStatus('error');
        }
      });

      setConnectionStatus('connected');
      addLog("📡 Connected to worker via capnweb RPC");

      let docId: string;
      let docName: string;

      if (documentId.trim()) {
        // Load existing document
        docId = documentId.trim();
        addLog(`\n📄 Loading existing document: ${docId}`);
        const commits = await rpc.loadDocument(docId) as any[];
        if (commits.length === 0) {
          throw new Error(`Document ${docId} not found or empty`);
        }
        addLog(`✅ Document loaded with ${commits.length} commits`);

        // Check if document exists in SQLite, create if not
        let doc = await sqliteService.loadDocument(docId);
        if (!doc) {
          doc = {
            id: docId,
            name: `Shared Document ${docId.substring(0, 8)}`,
            createdAt: Date.now(),
            lastModified: Date.now()
          };
          await sqliteService.saveDocument(doc);
        }
        docName = doc.name;

        // Sync commits to SQLite
        for (const commit of commits) {
          const commitData: CRDTCommit = {
            id: `${docId}-${commit.hash}`,
            docId,
            parents: commit.parents,
            hash: commit.hash,
            contents: toUint8Array(commit.contents),
            timestamp: Date.now()
          };
          await sqliteService.saveCommit(commitData);
        }

      } else {
        // Create new document
        addLog("\n📄 Step 1: Creating new shared document");
        const initialCommit = await createCommit("Initial document content");
        const createResult = await rpc.createDoc({
          initialCommit,
          otherParents: [],
        });

        docId = createResult.id;
        docName = `CRDT Demo ${new Date().toLocaleString()}`;

        // Save document to SQLite
        const doc: CRDTDoc = {
          id: docId,
          name: docName,
          createdAt: Date.now(),
          lastModified: Date.now()
        };
        await sqliteService.saveDocument(doc);

        addLog(`✅ Document created and saved to SQLite: ${docId}`);
        addLog(`📝 Initial commit: ${initialCommit.hash}`);

        // Save initial commit to SQLite
        const initialCommitData: CRDTCommit = {
          id: `${docId}-${initialCommit.hash}`,
          docId,
          parents: initialCommit.parents,
          hash: initialCommit.hash,
          contents: initialCommit.contents,
          timestamp: Date.now()
        };
        await sqliteService.saveCommit(initialCommitData);
      }

      setCurrentDocId(docId);

      // Load current state
      let commits = await rpc.loadDocument(docId) as any[];
      addLog(`📊 Current commits: ${commits.length}`);
      commits.forEach((commit, i) => {
        const content = toUint8Array(commit.contents);
        addLog(`  ${i + 1}. ${commit.hash.substring(0, 8)}: "${new TextDecoder().decode(content)}"`);
      });

      // Start sync if enabled
      if (syncEnabled) {
        addLog("\n🔄 Starting real-time sync (polling every 2 seconds)");
        syncIntervalRef.current = setInterval(syncDocument, 2000);
      }

      addLog(`\n✨ Multi-client sync ready! Document ID: ${docId}`);
      addLog("Share this ID with other browser tabs/windows to sync changes.");
      addLog("Use 'Add Commit' button to add new changes, or enable sync to see updates from others.");

      // Refresh documents list
      const updatedDocs = await sqliteService.getAllDocuments();
      setDocuments(updatedDocs);

    } catch (error: any) {
      if (error.message && error.message.includes("RPC session was shut down by disposing the main stub")) {
        addLog("✅ CRDT demonstration completed successfully (RPC connection closed as expected)");
      } else {
        addLog(`❌ Error during CRDT demonstration: ${error.message}`);
        setConnectionStatus('error');
      }
    }
  };

  const stopDemo = async () => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    if (rpcRef.current) {
      await disposeStub(rpcRef.current);
      rpcRef.current = null;
    }
    setIsRunning(false);
    setConnectionStatus('disconnected');
    setCurrentDocId(null);
    addLog("🛑 Demo stopped");
  };

  const addCommit = async () => {
    if (!rpcRef.current || !currentDocId) return;

    try {
      const content = `Commit from ${new Date().toLocaleTimeString()}`;
      const commit = await createCommit(content, []); // Will be merged properly
      await rpcRef.current.addCommits({ docId: currentDocId, commits: [commit] });
      addLog(`✅ Added commit: ${commit.hash.substring(0, 8)}...`);

      // Save to SQLite
      const commitData: CRDTCommit = {
        id: `${currentDocId}-${commit.hash}`,
        docId: currentDocId,
        parents: commit.parents,
        hash: commit.hash,
        contents: commit.contents,
        timestamp: Date.now()
      };
      await sqliteService.saveCommit(commitData);

      // Update document last modified
      const doc = await sqliteService.loadDocument(currentDocId);
      if (doc) {
        doc.lastModified = Date.now();
        await sqliteService.saveDocument(doc);
        setDocuments(prev => prev.map(d => d.id === currentDocId ? doc : d));
      }

    } catch (error) {
      addLog(`❌ Error adding commit: ${error}`);
    }
  };

  const syncDocument = async () => {
    if (!rpcRef.current || !currentDocId) return;

    try {
      const commits = await rpcRef.current.loadDocument(currentDocId) as any[];
      addLog(`🔄 Synced ${commits.length} commits`);

      // Save new commits to SQLite
      for (const commit of commits) {
        const commitData: CRDTCommit = {
          id: `${currentDocId}-${commit.hash}`,
          docId: currentDocId,
          parents: commit.parents,
          hash: commit.hash,
          contents: toUint8Array(commit.contents),
          timestamp: Date.now()
        };
        await sqliteService.saveCommit(commitData);
      }

      // Update document
      const doc = await sqliteService.loadDocument(currentDocId);
      if (doc) {
        doc.lastModified = Date.now();
        await sqliteService.saveDocument(doc);
        setDocuments(prev => prev.map(d => d.id === currentDocId ? doc : d));
      }

    } catch (error) {
      addLog(`❌ Sync error: ${error}`);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>CRDT Conflict-Free Replication Demo</h1>
        <p>Demonstrating Sedimentree-based Commit Graph CRDT with Multi-Client Sync</p>
      </header>

      <main>
        <div className="document-controls">
          <div className="control-group">
            <label htmlFor="documentId">Document ID (leave empty to create new):</label>
            <input
              id="documentId"
              type="text"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              placeholder="Enter existing document ID"
              disabled={isRunning}
            />
          </div>
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={syncEnabled}
                onChange={(e) => setSyncEnabled(e.target.checked)}
                disabled={isRunning}
              />
              Enable real-time sync (polls every 2 seconds)
            </label>
          </div>
          {currentDocId && (
            <div className="current-doc">
              Current Document: <code>{currentDocId}</code>
            </div>
          )}
        </div>

        <div className="controls">
          <button
            onClick={demonstrateCRDT}
            disabled={isRunning}
            className="start-button"
          >
            {isRunning ? 'Running...' : '🚀 Start CRDT Demo'}
          </button>
          <button
            onClick={stopDemo}
            disabled={!isRunning}
            className="stop-button"
          >
            🛑 Stop Demo
          </button>
          <button
            onClick={clearLogs}
            className="clear-button"
          >
            🧹 Clear Logs
          </button>
          {isRunning && (
            <button
              onClick={addCommit}
              className="add-commit-button"
            >
              ➕ Add Commit
            </button>
          )}
        </div>

        <div className="status">
          <span className={`status-indicator ${connectionStatus}`}>
            Status: {connectionStatus}
          </span>
          <span className={`status-indicator ${sqliteInitialized ? 'connected' : 'error'}`}>
            SQLite: {sqliteInitialized ? 'Ready' : 'Initializing...'}
          </span>
        </div>

        <div className="logs-container">
          <h3>Demo Output</h3>
          <div className="logs">
            {logs.length === 0 ? (
              <p className="empty-logs">Click "Start CRDT Demo" to begin the demonstration</p>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="log-entry">
                  {log}
                </div>
              ))
            )}
          </div>
        </div>

        {documents.length > 0 && (
          <div className="documents-container">
            <h3>Saved Documents ({documents.length})</h3>
            <div className="documents-list">
              {documents.map((doc) => (
                <div key={doc.id} className="document-item">
                  <div className="document-info">
                    <strong>{doc.name}</strong>
                    <small>
                      Created: {new Date(doc.createdAt).toLocaleString()}<br/>
                      Modified: {new Date(doc.lastModified).toLocaleString()}
                    </small>
                  </div>
                  <div className="document-actions">
                    <button
                      className="view-button"
                      onClick={async () => {
                        try {
                          const commits = await sqliteService.loadCommits(doc.id);
                          addLog(`📄 Loading document: ${doc.name}`);
                          addLog(`📊 Found ${commits.length} commits:`);
                          commits.forEach((commit, i) => {
                            const content = new TextDecoder().decode(commit.contents);
                            addLog(`  ${i + 1}. ${commit.hash.substring(0, 8)}: "${content}"`);
                          });
                        } catch (error) {
                          addLog(`❌ Error loading document: ${error}`);
                        }
                      }}
                    >
                      View
                    </button>
                    <button
                      className="rename-button"
                      onClick={async () => {
                        const newName = prompt('Enter new name for document:', doc.name);
                        if (newName && newName.trim() && newName !== doc.name) {
                          try {
                            doc.name = newName.trim();
                            doc.lastModified = Date.now();
                            await sqliteService.updateDocument(doc);
                            setDocuments(prev => prev.map(d => d.id === doc.id ? doc : d));
                            addLog(`✏️ Document renamed to: ${doc.name}`);
                          } catch (error) {
                            addLog(`❌ Error renaming document: ${error}`);
                          }
                        }
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="delete-button"
                      onClick={async () => {
                        if (confirm(`Are you sure you want to delete "${doc.name}"?`)) {
                          try {
                            await sqliteService.deleteDocument(doc.id);
                            setDocuments(prev => prev.filter(d => d.id !== doc.id));
                            addLog(`🗑️ Document deleted: ${doc.name}`);
                          } catch (error) {
                            addLog(`❌ Error deleting document: ${error}`);
                          }
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="data-actions">
              <button
                className="export-data-button"
                onClick={async () => {
                  try {
                    const docs = await sqliteService.getAllDocuments();
                    const allData: any = { documents: [], commits: [] };
                    for (const doc of docs) {
                      allData.documents.push(doc);
                      const commits = await sqliteService.loadCommits(doc.id);
                      allData.commits.push(...commits);
                    }

                    const dataStr = JSON.stringify(allData, null, 2);
                    const blob = new Blob([dataStr], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `crdt-data-${new Date().toISOString().split('T')[0]}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);

                    addLog('📤 Data exported successfully');
                  } catch (error) {
                    addLog(`❌ Error exporting data: ${error}`);
                  }
                }}
              >
                Export Data
              </button>
              <button
                className="import-data-button"
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.json';
                  input.onchange = async (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;

                    try {
                      const text = await file.text();
                      const data = JSON.parse(text);

                      if (data.documents && data.commits) {
                        // Clear existing data
                        await sqliteService.clearAllData();

                        // Import documents
                        for (const doc of data.documents) {
                          await sqliteService.saveDocument(doc);
                        }

                        // Import commits
                        for (const commit of data.commits) {
                          await sqliteService.saveCommit(commit);
                        }

                        // Refresh UI
                        const updatedDocs = await sqliteService.getAllDocuments();
                        setDocuments(updatedDocs);

                        addLog(`📥 Imported ${data.documents.length} documents and ${data.commits.length} commits`);
                      } else {
                        addLog('❌ Invalid data format');
                      }
                    } catch (error) {
                      addLog(`❌ Error importing data: ${error}`);
                    }
                  };
                  input.click();
                }}
              >
                Import Data
              </button>
              <button
                className="clear-data-button"
                onClick={async () => {
                  if (confirm('Are you sure you want to clear all saved data?')) {
                    try {
                      await sqliteService.clearAllData();
                      setDocuments([]);
                      addLog('🧹 All data cleared from SQLite database');
                    } catch (error) {
                      addLog(`❌ Error clearing data: ${error}`);
                    }
                  }
                }}
              >
                Clear All Data
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App