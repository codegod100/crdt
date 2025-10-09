import { useState, useRef, useEffect } from 'react'
import { newWebSocketRpcSession, RpcStub } from 'capnweb'
import { sqliteService, type Channel, type Message } from './sqliteService'
import './App.css'

interface CommitSnapshot {
  parents: string[];
  hash: string;
  contents: Uint8Array;
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
  createDoc(options: CreateDocOptions): Promise<CreateDocResult>;
  loadDocument(docId: string): Promise<CommitSnapshot[]>;
  addCommits(options: unknown): Promise<{ success: boolean }>;
  addWorkerCommit(docId: string, content: string): Promise<{ success: boolean; commitHash: string }>;
  createContactCard(): Promise<{ card: string }>;
  createStream(options: unknown): Promise<{ streamId: string }>;
  waitUntilSynced(peerId: string): Promise<{ synced: boolean }>;
  stop(): Promise<void>;
  hello(name: string): Promise<string>;
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
   const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
   const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sqliteInitialized, setSqliteInitialized] = useState(false);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [userName, setUserName] = useState('');
  const [messageInput, setMessageInput] = useState('');
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

        // Load existing channels
        try {
          const loadedChannels = await sqliteService.getAllChannels();
          setChannels(loadedChannels);
          if (loadedChannels.length > 0) {
            addLog(`📁 Found ${loadedChannels.length} existing channel(s)`);
          }
        } catch (error) {
          addLog(`⚠️  Could not load channels: ${error}`);
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



  const disposeStub = async (stub: RpcStub<BeelayApi>) => {
    try {
      if (typeof (stub as any)[(Symbol as any).dispose] === "function") {
        (stub as any)[(Symbol as any).dispose]();
      }
    } catch {
      console.log("Disposal completed");
    }
  };

  const createChannel = async (channelName: string) => {
    if (!channelName.trim() || !sqliteInitialized) return;

    try {
      const channel = await sqliteService.createChannel(channelName.trim());
      setChannels(prev => [channel, ...prev]);
      addLog(`✅ Created channel: ${channel.name}`);
      return channel;
    } catch (error) {
      addLog(`❌ Error creating channel: ${error}`);
      return null;
    }
  };

  const selectChannel = async (channel: Channel) => {
    setCurrentChannel(channel);
    setConnectionStatus('connecting');

    try {
      // Connect to worker for this channel's document
      const workerUrl = import.meta.env.VITE_WORKER_URL || "ws://localhost:8787";
      const rpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      rpcRef.current = rpc;

      rpc.onRpcBroken((error) => {
        if (error.message && error.message.includes("RPC session was shut down by disposing the main stub")) {
          setConnectionStatus('disconnected');
        } else {
          addLog(`❌ Connection lost: ${error.message}`);
          setConnectionStatus('error');
        }
      });

      // Create document if temp or invalid
      if (channel.docId.startsWith('temp-') || channel.docId.startsWith('channel-')) {
        const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
        const result = await rpc.createDoc({
          initialCommit,
          otherParents: []
        });
        const newDocId = result.id;
        await sqliteService.updateChannelDocId(channel.id, newDocId);
        setChannels(prev => prev.map(c => c.id === channel.id ? { ...c, docId: newDocId } : c));
        channel.docId = newDocId;
        setCurrentChannel(channel);
      } else {
        // Check if the docId is valid by trying to load
        try {
          await rpc.loadDocument(channel.docId);
        } catch (error: any) {
          if (error.message && error.message.includes("invalid document Id")) {
            // Recreate the doc with valid id
            const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
            const result = await rpc.createDoc({
              initialCommit,
              otherParents: []
            });
            const newDocId = result.id;
            await sqliteService.updateChannelDocId(channel.id, newDocId);
            setChannels(prev => prev.map(c => c.id === channel.id ? { ...c, docId: newDocId } : c));
            channel.docId = newDocId;
            setCurrentChannel(channel);
          } else {
            throw error;
          }
        }
      }

      setConnectionStatus('connected');
      addLog(`📡 Connected to channel: ${channel.name}`);

      // Load existing messages for this channel
      const channelMessages = await sqliteService.getMessagesForChannel(channel.id);
      setMessages(channelMessages);

      // Start sync if enabled
      if (syncEnabled) {
        addLog("🔄 Starting real-time sync (polling every 2 seconds)");
        syncIntervalRef.current = setInterval(() => syncChannel(channel), 2000);
      }

    } catch (error) {
      addLog(`❌ Error connecting to channel: ${error}`);
      setConnectionStatus('error');
    }
  };

  const sendMessage = async () => {
    if (!messageInput.trim() || !currentChannel || !currentChannel.docId || !userName.trim() || !rpcRef.current) return;

    try {
      const messageContent = {
        user: userName.trim(),
        content: messageInput.trim(),
        timestamp: Date.now()
      };

      // Add commit via worker
      const result = await rpcRef.current.addWorkerCommit(currentChannel.docId as string, JSON.stringify(messageContent));

      if (result.success) {
        // Save message to SQLite
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          channelId: currentChannel.id,
          user: userName.trim(),
          content: messageInput.trim(),
          timestamp: Date.now(),
          commitHash: result.commitHash
        };

        await sqliteService.saveMessage(message);
        setMessages(prev => [...prev, message]);
        setMessageInput('');

        addLog(`💬 Message sent: ${message.content.substring(0, 50)}...`);
      } else {
        addLog(`❌ Failed to add commit`);
      }

    } catch (error) {
      addLog(`❌ Error sending message: ${error}`);
    }
  };

  const syncChannel = async (channel: Channel) => {
    if (!rpcRef.current) return;

    try {
      const commits: CommitSnapshot[] = await rpcRef.current.loadDocument(channel.docId);

      // Process new commits as messages
      for (const commit of commits) {
        const content = toUint8Array(commit.contents);
        const messageData = JSON.parse(new TextDecoder().decode(content));

        // Check if we already have this message
        const existingMessage = messages.find(m => m.commitHash === commit.hash);
        if (!existingMessage && messageData.user && messageData.content) {
          const message: Message = {
            id: `msg-${commit.hash}`,
            channelId: channel.id,
            user: messageData.user,
            content: messageData.content,
            timestamp: messageData.timestamp || Date.now(),
            commitHash: commit.hash
          };

          await sqliteService.saveMessage(message);
          setMessages(prev => {
            // Avoid duplicates
            if (prev.find(m => m.commitHash === commit.hash)) return prev;
            return [...prev, message].sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      }

    } catch (error) {
      addLog(`❌ Sync error: ${error}`);
    }
  };

  const leaveChannel = async () => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    if (rpcRef.current) {
      await disposeStub(rpcRef.current);
      rpcRef.current = null;
    }
    setCurrentChannel(null);
    setMessages([]);
    setConnectionStatus('disconnected');
    addLog("👋 Left channel");
  };

  return (
    <div className="app">
      <header>
        <h1>CRDT Channel Chat</h1>
        <p>Real-time collaborative messaging with CRDT conflict resolution</p>
      </header>

      <main>
        <div className="chat-layout">
          {/* Channel Sidebar */}
          <div className="channels-sidebar">
            <div className="channel-controls">
              <input
                type="text"
                placeholder="Your name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="user-input"
              />
              <div className="create-channel">
                <input
                  type="text"
                  placeholder="New channel name"
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      createChannel((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).value = '';
                    }
                  }}
                  className="channel-input"
                />
                <button
                  onClick={() => {
                    const input = document.querySelector('.channel-input') as HTMLInputElement;
                    createChannel(input.value);
                    input.value = '';
                  }}
                  className="create-button"
                >
                  +
                </button>
              </div>
            </div>

            <div className="channels-list">
              <h3>Channels ({channels.length})</h3>
              {channels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${currentChannel?.id === channel.id ? 'active' : ''}`}
                  onClick={() => selectChannel(channel)}
                >
                  <div className="channel-name">#{channel.name}</div>
                  <div className="channel-meta">
                    {new Date(channel.lastModified).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Messages Area */}
          <div className="messages-area">
            {currentChannel ? (
              <>
                <div className="channel-header">
                  <h2>#{currentChannel.name}</h2>
                  <div className="channel-actions">
                    <label className="sync-toggle">
                      <input
                        type="checkbox"
                        checked={syncEnabled}
                        onChange={(e) => setSyncEnabled(e.target.checked)}
                      />
                      Live sync
                    </label>
                    <button onClick={leaveChannel} className="leave-button">
                      Leave
                    </button>
                  </div>
                </div>

                <div className="messages-container">
                  {messages.length === 0 ? (
                    <div className="empty-messages">
                      <p>No messages yet. Start the conversation!</p>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <div key={message.id} className="message-item">
                        <div className="message-header">
                          <span className="message-user">{message.user}</span>
                          <span className="message-time">
                            {new Date(message.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="message-content">{message.content}</div>
                      </div>
                    ))
                  )}
                </div>

                <div className="message-input-area">
                  <input
                    type="text"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                    placeholder="Type a message..."
                    disabled={!userName.trim()}
                    className="message-input"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!messageInput.trim() || !userName.trim()}
                    className="send-button"
                  >
                    Send
                  </button>
                </div>
              </>
            ) : (
              <div className="welcome-screen">
                <h2>Welcome to CRDT Chat!</h2>
                <p>Select a channel from the sidebar to start chatting, or create a new one.</p>
                <div className="status">
                  <span className={`status-indicator ${connectionStatus}`}>
                    Status: {connectionStatus}
                  </span>
                  <span className={`status-indicator ${sqliteInitialized ? 'connected' : 'error'}`}>
                    SQLite: {sqliteInitialized ? 'Ready' : 'Initializing...'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="logs-container">
          <h3>Activity Log</h3>
          <div className="logs">
            {logs.length === 0 ? (
              <p className="empty-logs">Activity will appear here</p>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="log-entry">
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default App