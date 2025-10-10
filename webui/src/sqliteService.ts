/* eslint-disable @typescript-eslint/no-explicit-any */
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

export interface Channel {
  id: string;
  name: string;
  docId: string;
  createdAt: number;
  lastModified: number;
}

export interface Message {
  id: string;
  channelId: string;
  user: string;
  content: string;
  timestamp: number;
  commitHash: string;
}

export interface ChannelDocument {
  channelId: string;
  content: string;
  updatedAt: number;
  latestCommitHash: string | null;
}

class SQLiteService {
  private db: any = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {

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
        this.initPromise = null; // Reset on failure
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

       CREATE TABLE IF NOT EXISTS channels (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         doc_id TEXT,
         created_at INTEGER NOT NULL,
         last_modified INTEGER NOT NULL,
         FOREIGN KEY (doc_id) REFERENCES documents (id)
       );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        commit_hash TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels (id)
      );

      CREATE INDEX IF NOT EXISTS idx_commits_doc_id ON commits (doc_id);
      CREATE INDEX IF NOT EXISTS idx_commits_hash ON commits (hash);
      CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits (timestamp);
      CREATE INDEX IF NOT EXISTS idx_documents_last_modified ON documents (last_modified);
      CREATE INDEX IF NOT EXISTS idx_channels_doc_id ON channels (doc_id);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);

      CREATE TABLE IF NOT EXISTS channel_documents (
        channel_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        latest_commit_hash TEXT,
        FOREIGN KEY (channel_id) REFERENCES channels (id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_documents_updated_at ON channel_documents (updated_at);
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
      DELETE FROM messages;
      DELETE FROM channels;
      DELETE FROM commits;
      DELETE FROM documents;
      DELETE FROM channel_documents;
    `;

    if (this.db && typeof this.db === 'function') {
      // Using worker promiser API
      await this.db('exec', { sql });
    } else if (this.db && this.db.exec) {
      // Using direct DB API
      this.db.exec(sql);
    }
  }

  async createChannel(name: string): Promise<Channel> {
    await this.ensureInitialized();

    const channelId = `chan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Save channel with temporary docId
    const tempDocId = `temp-${channelId}`;
    const channel: Channel = {
      id: channelId,
      name,
      docId: tempDocId,
      createdAt: Date.now(),
      lastModified: Date.now()
    };

    const sql = `
      INSERT INTO channels (id, name, doc_id, created_at, last_modified)
      VALUES (?, ?, ?, ?, ?)
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [channel.id, channel.name, channel.docId, channel.createdAt, channel.lastModified]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [channel.id, channel.name, channel.docId, channel.createdAt, channel.lastModified]
      });
    }

    return channel;
  }

  async getAllChannels(): Promise<Channel[]> {
    await this.ensureInitialized();

    const sql = 'SELECT * FROM channels ORDER BY last_modified DESC';

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
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

      if (!Array.isArray(rows)) {
        console.error('getAllChannels: rows is not an array after processing:', rows, 'result:', result);
        return [];
      }

      return rows.map((row: any[]) => ({
        id: row[0],
        name: row[1],
        docId: row[2] || `temp-${row[0]}`,
        createdAt: row[3],
        lastModified: row[4]
      }));
    } else if (this.db && this.db.selectObjects) {
      const rows = this.db.selectObjects(sql);
      if (!Array.isArray(rows)) {
        console.warn('getAllChannels: rows is not an array:', rows);
        return [];
      }
      return rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        docId: row.doc_id || `temp-${row.id}`,
        createdAt: row.created_at,
        lastModified: row.last_modified
      }));
    }

    return [];
  }

  async updateChannelDocId(channelId: string, docId: string): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      UPDATE channels SET doc_id = ?, last_modified = ? WHERE id = ?
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [docId, Date.now(), channelId]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [docId, Date.now(), channelId]
      });
    }
  }

  async saveMessage(message: Message): Promise<boolean> {
    await this.ensureInitialized();

    const sql = `
      INSERT OR IGNORE INTO messages (id, channel_id, user, content, timestamp, commit_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [message.id, message.channelId, message.user, message.content, message.timestamp, message.commitHash]
      });

      const changesResult = await this.db('exec', {
        sql: 'SELECT changes()',
        returnValue: 'resultRows'
      });

      let rows: any[] = [];
      if (Array.isArray(changesResult)) {
        rows = changesResult;
      } else if (changesResult?.result?.resultRows) {
        rows = changesResult.result.resultRows;
      } else if (changesResult?.resultRows) {
        rows = changesResult.resultRows;
      }

      const changes = Array.isArray(rows) && rows.length > 0 ? Number(rows[0][0]) : 0;
      return changes > 0;
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [message.id, message.channelId, message.user, message.content, message.timestamp, message.commitHash]
      });

      if (typeof this.db.changes === 'function') {
        return this.db.changes() > 0;
      }

      return true;
    }

    return false;
  }

  async getMessagesForChannel(channelId: string): Promise<Message[]> {
    await this.ensureInitialized();

    const sql = 'SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC';

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
        bind: [channelId],
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

      if (!Array.isArray(rows)) {
        console.error('getMessagesForChannel: rows is not an array after processing:', rows, 'result:', result);
        return [];
      }

      return rows.map((row: any[]) => ({
        id: row[0],
        channelId: row[1],
        user: row[2],
        content: row[3],
        timestamp: row[4],
        commitHash: row[5]
      }));
    } else if (this.db && this.db.selectObjects) {
      const rows = this.db.selectObjects(sql, [channelId]);
      if (!Array.isArray(rows)) {
        console.warn('getMessagesForChannel: rows is not an array:', rows);
        return [];
      }
      return rows.map((row: any) => ({
        id: row.id,
        channelId: row.channel_id,
        user: row.user,
        content: row.content,
        timestamp: row.timestamp,
        commitHash: row.commit_hash
      }));
    }

    return [];
  }

  async saveChannelDocument(document: ChannelDocument): Promise<void> {
    await this.ensureInitialized();

    const sql = `
      INSERT INTO channel_documents (channel_id, content, updated_at, latest_commit_hash)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at,
        latest_commit_hash = excluded.latest_commit_hash
    `;

    if (this.db && typeof this.db === 'function') {
      await this.db('exec', {
        sql,
        bind: [document.channelId, document.content, document.updatedAt, document.latestCommitHash]
      });
    } else if (this.db && this.db.exec) {
      this.db.exec(sql, {
        bind: [document.channelId, document.content, document.updatedAt, document.latestCommitHash]
      });
    }
  }

  async getChannelDocument(channelId: string): Promise<ChannelDocument | null> {
    await this.ensureInitialized();

    const sql = `
      SELECT channel_id, content, updated_at, latest_commit_hash
      FROM channel_documents
      WHERE channel_id = ?
    `;

    if (this.db && typeof this.db === 'function') {
      const result = await this.db('exec', {
        sql,
        bind: [channelId],
        returnValue: 'resultRows'
      });

      let rows: any[] = [];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result?.result?.resultRows) {
        rows = result.result.resultRows;
      } else if (result?.resultRows) {
        rows = result.resultRows;
      }

      if (Array.isArray(rows) && rows.length > 0) {
        const [id, content, updatedAt, hash] = rows[0];
        return {
          channelId: id,
          content,
          updatedAt,
          latestCommitHash: hash ?? null
        };
      }
    } else if (this.db && this.db.selectObject) {
      const row = this.db.selectObject(sql, [channelId]);
      if (row) {
        return {
          channelId: row.channel_id,
          content: row.content,
          updatedAt: row.updated_at,
          latestCommitHash: row.latest_commit_hash ?? null
        };
      }
    }

    return null;
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