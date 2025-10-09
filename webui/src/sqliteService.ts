import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

export interface CRDTCommit {
  id: string;
  docId: string;
  parents: string[];
  hash: string;
  contents: Uint8Array;
  timestamp: number;
}

export interface CRDTDoc {
  id: string;
  name: string;
  createdAt: number;
  lastModified: number;
}

class SQLiteService {
  private db: any = null;
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      console.log('Initializing SQLite WASM...');

      // Check if SharedArrayBuffer is available (required for OPFS)
      const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
      console.log('SharedArrayBuffer available:', hasSharedArrayBuffer);

      if (!hasSharedArrayBuffer) {
        console.warn('SharedArrayBuffer not available - OPFS will not work');
        console.warn('This requires COOP/COEP headers from the server');
        throw new Error('SharedArrayBuffer not available');
      }

      // Try to use OPFS (Origin Private File System) for persistence
      // This requires COOP/COEP headers to be set
      console.log('Attempting to initialize with OPFS support...');

      const promiser = await new Promise((resolve, reject) => {
        const _promiser = (globalThis as any).sqlite3Worker1Promiser({
          onready: () => resolve(_promiser),
          onError: (err: any) => reject(err),
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          reject(new Error('SQLite WASM initialization timeout'));
        }, 5000);
      });

      console.log('SQLite WASM initialized with worker promiser');

      // Open database with OPFS for persistence
      const openResponse = await (promiser as any)('open', {
        filename: 'file:crdt-db.sqlite3?vfs=opfs',
      });

      console.log('Database opened with OPFS:', openResponse.result.filename);
      this.db = promiser;

      // Create tables
      await this.createTables();

      this.isInitialized = true;
      console.log('✅ SQLite database initialized successfully with OPFS persistence');

    } catch (error: any) {
      console.warn('❌ OPFS not available, falling back to in-memory database:', error.message);

      // Provide helpful error messages
      if (error.message.includes('SharedArrayBuffer')) {
        console.warn('💡 To enable OPFS persistence:');
        console.warn('   - Server must send COOP/COEP headers');
        console.warn('   - Cross-Origin-Opener-Policy: same-origin');
        console.warn('   - Cross-Origin-Embedder-Policy: require-corp');
      }

      try {
        // Fallback to in-memory database
        console.log('🔄 Initializing in-memory SQLite database...');
        const sqlite3 = await sqlite3InitModule();
        this.db = new sqlite3.oo1.DB('/crdt-db.sqlite3', 'ct');
        await this.createTables();
        this.isInitialized = true;

        console.log('✅ SQLite database initialized (in-memory fallback)');
        console.warn('⚠️  Data will not persist between browser sessions');
        console.warn('   Use a server with COOP/COEP headers for persistent storage');

      } catch (fallbackError: any) {
        console.error('❌ Failed to initialize SQLite fallback:', fallbackError);
        throw new Error(`SQLite initialization failed: ${fallbackError.message}`);
      }
    }
  }

  private async createTables(): Promise<void> {
    const createTablesSQL = `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_modified INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commits (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        parents TEXT NOT NULL, -- JSON array of parent hashes
        hash TEXT NOT NULL,
        contents BLOB NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents (id)
      );

      CREATE INDEX IF NOT EXISTS idx_commits_doc_id ON commits (doc_id);
      CREATE INDEX IF NOT EXISTS idx_commits_hash ON commits (hash);
      CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits (timestamp);
      CREATE INDEX IF NOT EXISTS idx_documents_last_modified ON documents (last_modified);
    `;

    if (this.db && typeof this.db === 'function') {
      // Using worker promiser API
      await this.db('exec', { sql: createTablesSQL });
    } else if (this.db && this.db.exec) {
      // Using direct DB API
      this.db.exec(createTablesSQL);
    }
  }

  async saveDocument(doc: CRDTDoc): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      INSERT OR REPLACE INTO documents (id, name, created_at, last_modified)
      VALUES (?, ?, ?, ?)
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [doc.id, doc.name, doc.createdAt, doc.lastModified]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [doc.id, doc.name, doc.createdAt, doc.lastModified]
      });
    }
  }

  async loadDocument(docId: string): Promise<CRDTDoc | null> {
    await this.ensureInitialized();

    const sql = 'SELECT * FROM documents WHERE id = ?';

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
        bind: [docId],
        returnValue: 'resultRows'
      });
      let rows: any[];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result.result && result.result.resultRows) {
        rows = result.result.resultRows;
      } else if (result.resultRows) {
        rows = result.resultRows;
      } else if (result.result) {
        rows = result.result;
      } else {
        rows = [];
      }
      if (rows.length > 0) {
        const row = rows[0];
        return {
          id: row[0],
          name: row[1],
          createdAt: row[2],
          lastModified: row[3]
        };
      }
    } else if (this.db && this.db.selectObject) {
      return this.db.selectObject(sql, [docId]);
    }

    return null;
  }

  async saveCommit(commit: CRDTCommit): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      INSERT OR REPLACE INTO commits (id, doc_id, parents, hash, contents, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const parentsJson = JSON.stringify(commit.parents);

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [commit.id, commit.docId, parentsJson, commit.hash, commit.contents, commit.timestamp]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [commit.id, commit.docId, parentsJson, commit.hash, commit.contents, commit.timestamp]
      });
    }
  }

  async loadCommits(docId: string): Promise<CRDTCommit[]> {
    await this.ensureInitialized();

    const sql = 'SELECT * FROM commits WHERE doc_id = ? ORDER BY timestamp ASC';

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
        bind: [docId],
        returnValue: 'resultRows'
      });

      let rows: any[];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result.result && result.result.resultRows) {
        rows = result.result.resultRows;
      } else if (result.resultRows) {
        rows = result.resultRows;
      } else if (result.result) {
        rows = result.result;
      } else {
        rows = [];
      }

      return rows.map((row: any[]) => ({
        id: row[0],
        docId: row[1],
        parents: JSON.parse(row[2]),
        hash: row[3],
        contents: row[4], // Uint8Array
        timestamp: row[5]
      }));
    } else if (this.db && this.db.selectObjects) {
      const rows = this.db.selectObjects(sql, [docId]);
      if (!Array.isArray(rows)) {
        console.warn('loadCommits: rows is not an array:', rows);
        return [];
      }
      return rows.map((row: any) => ({
        id: row.id,
        docId: row.doc_id,
        parents: JSON.parse(row.parents),
        hash: row.hash,
        contents: row.contents,
        timestamp: row.timestamp
      }));
    }

    return [];
  }

  async getAllDocuments(): Promise<CRDTDoc[]> {
    await this.ensureInitialized();

    const sql = 'SELECT * FROM documents ORDER BY last_modified DESC';

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
        returnValue: 'resultRows'
      });

      // Handle the result object from SQLite WASM
      let rows: any[];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result.result && result.result.resultRows) {
        rows = result.result.resultRows;
      } else if (result.resultRows) {
        rows = result.resultRows;
      } else if (result.result) {
        rows = result.result;
      } else {
        // No rows returned
        rows = [];
      }

      if (!Array.isArray(rows)) {
        console.error('getAllDocuments: rows is not an array after processing:', rows, 'result:', result);
        return [];
      }

      if (!Array.isArray(rows)) {
        console.error('getAllDocuments: rows is not an array after processing:', rows, 'result:', result);
        return [];
      }

      return rows.map((row: any[]) => ({
        id: row[0],
        name: row[1],
        createdAt: row[2],
        lastModified: row[3]
      }));
    } else if (this.db && this.db.selectObjects) {
      const rows = this.db.selectObjects(sql);
      if (!Array.isArray(rows)) {
        console.warn('getAllDocuments: rows is not an array:', rows);
        return [];
      }
      return rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastModified: row.last_modified
      }));
    }

    return [];
  }

  async updateDocument(doc: CRDTDoc): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      UPDATE documents SET name = ?, last_modified = ? WHERE id = ?
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [doc.name, doc.lastModified, doc.id]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [doc.name, doc.lastModified, doc.id]
      });
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.ensureInitialized();

    // Delete commits first (foreign key constraint)
    const deleteCommitsSQL = 'DELETE FROM commits WHERE doc_id = ?';
    const deleteDocSQL = 'DELETE FROM documents WHERE id = ?';

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', { sql: deleteCommitsSQL, bind: [docId] });
      await this.db('exec', { sql: deleteDocSQL, bind: [docId] });
    } else if (this.db && this.db.exec) {
      this.db.exec(deleteCommitsSQL, { bind: [docId] });
      this.db.exec(deleteDocSQL, { bind: [docId] });
    }
  }

  async clearAllData(): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      DELETE FROM commits;
      DELETE FROM documents;
    `;

    if (this.db && typeof this.db === 'function') {
      // Using worker promiser API
      await this.db('exec', { sql });
    } else if (this.db && this.db.exec) {
      // Using direct DB API
      this.db.exec(sql);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  async close(): Promise<void> {
    if (this.db && typeof this.db === 'function') {
      // Worker promiser doesn't have a direct close method
      console.log('SQLite database connection maintained');
    } else if (this.db && this.db.close) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
    }
  }
}

export const sqliteService = new SQLiteService();