import { useState, useRef, useEffect } from 'react'
import { newWebSocketRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { sqliteService, type Channel, type Message } from './sqliteService'
import './App.css'

const symbolDispose: symbol = typeof (Symbol as { dispose?: symbol }).dispose === 'symbol'
  ? (Symbol as { dispose: symbol }).dispose
  : Symbol.for('Symbol.dispose')

type DisposableStub = {
  [symbolDispose]?: () => void
}

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
  registerClientTarget(target: RpcTarget, docId?: string): Promise<{ success: boolean }>;
  unregisterClientTarget(target: RpcTarget, docId?: string): Promise<{ success: boolean }>;
}

interface ServerCommitPayload {
  parents: string[];
  hash: string;
  contents: string | number[] | Uint8Array;
}

class ClientEventTarget extends RpcTarget {
  private readonly listener: (event: unknown) => void;

  constructor(listener: (event: unknown) => void) {
    super();
    this.listener = listener;
  }

  handleServerEvent(event: unknown) {
    this.listener(event);
  }
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

async function createCommit(content: string, parents: string[] = []): Promise<CommitSnapshot> {
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
  const rpcRef = useRef<RpcStub<BeelayApi> | null>(null);
  const clientTargetRef = useRef<ClientEventTarget | null>(null);
  const subscriptionActiveRef = useRef(false);
  const subscriptionDocIdRef = useRef<string | null>(null);
  const currentChannelRef = useRef<Channel | null>(null);
  const processedCommitHashesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  useEffect(() => {
    processedCommitHashesRef.current = new Set(messages.map(message => message.commitHash));
  }, [messages]);

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

  const processCommitEvent = async (docId: string, commitPayload: ServerCommitPayload) => {
    if (!currentChannelRef.current || currentChannelRef.current.docId !== docId) {
      return;
    }

    try {
      const contentArray = toUint8Array(commitPayload.contents);
      const decoded = new TextDecoder().decode(contentArray);
      const messageData = JSON.parse(decoded);

      if (!messageData.user || !messageData.content) {
        addLog(`⚠️  Received commit with unexpected payload: ${decoded}`);
        return;
      }

      const commitHash = commitPayload.hash;
      if (processedCommitHashesRef.current.has(commitHash)) {
        return;
      }

      const message: Message = {
        id: `msg-${commitHash}`,
        channelId: currentChannelRef.current.id,
        user: messageData.user,
        content: messageData.content,
        timestamp: messageData.timestamp ?? Date.now(),
        commitHash
      };

      const inserted = await sqliteService.saveMessage(message);

      setMessages(prev => {
        if (prev.find(m => m.commitHash === commitHash)) return prev;
        return [...prev, message].sort((a, b) => a.timestamp - b.timestamp);
      });

      if (!inserted && processedCommitHashesRef.current.has(commitHash)) {
        addLog(`↪️ Skipped duplicate commit ${commitHash.substring(0, 8)}`);
      } else {
        addLog(`📥 Received message commit ${commitHash.substring(0, 8)} from RPC`);
      }

      processedCommitHashesRef.current.add(commitHash);
    } catch (error) {
      const reason = error instanceof Error ? error.message : JSON.stringify(error);
      addLog(`❌ Failed to process commit event: ${reason}`);
    }
  };

  const isCommitPayload = (value: unknown): value is ServerCommitPayload => {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const payload = value as Partial<ServerCommitPayload>;
    return Array.isArray(payload.parents) && typeof payload.hash === 'string' && payload.contents !== undefined;
  };

  const handleServerEvent = async (rawEvent: unknown) => {
    if (!rawEvent || typeof rawEvent !== 'object' || !('type' in rawEvent)) {
      return;
    }

    const event = rawEvent as { type: string; [key: string]: unknown };

    switch (event.type) {
      case 'commitAdded':
        if (typeof event.docId === 'string' && isCommitPayload(event.commit)) {
          await processCommitEvent(event.docId, event.commit);
        }
        break;
      case 'commitsAdded':
        if (typeof event.docId === 'string' && Array.isArray(event.commits)) {
          for (const commit of event.commits) {
            if (isCommitPayload(commit)) {
              await processCommitEvent(event.docId, commit);
            }
          }
        }
        break;
      case 'docCreated':
        if (typeof event.id === 'string' && currentChannelRef.current && currentChannelRef.current.docId === event.id) {
          addLog(`📄 Document confirmed created: ${event.id}`);
        }
        break;
      default:
        addLog(`ℹ️ Received unhandled server event: ${JSON.stringify(event)}`);
    }
  };

  const ensureClientTarget = () => {
    if (!clientTargetRef.current) {
      clientTargetRef.current = new ClientEventTarget(handleServerEvent);
    }
    return clientTargetRef.current;
  };

  const subscribeToRpc = async (docId: string) => {
    if (!rpcRef.current) {
      addLog('⚠️  Cannot subscribe: RPC connection missing');
      return;
    }

    if (subscriptionActiveRef.current && subscriptionDocIdRef.current === docId) {
      return;
    }

    try {
      const target = ensureClientTarget();
      await rpcRef.current.registerClientTarget(target, docId);
      subscriptionActiveRef.current = true;
      subscriptionDocIdRef.current = docId;
      addLog('🔔 Subscribed to RPC updates');
    } catch (error) {
      subscriptionActiveRef.current = false;
      subscriptionDocIdRef.current = null;
      addLog(`❌ Failed to subscribe to RPC updates: ${error}`);
    }
  };

  const unsubscribeFromRpc = async () => {
    if (!subscriptionActiveRef.current || !rpcRef.current || !clientTargetRef.current) {
      subscriptionActiveRef.current = false;
      subscriptionDocIdRef.current = null;
      return;
    }

    try {
      await rpcRef.current.unregisterClientTarget(clientTargetRef.current, subscriptionDocIdRef.current ?? undefined);
      addLog('🔕 Unsubscribed from RPC updates');
    } catch (error) {
      addLog(`⚠️  Failed to unsubscribe from RPC updates cleanly: ${error}`);
    } finally {
      subscriptionActiveRef.current = false;
      subscriptionDocIdRef.current = null;
    }
  };



  const disposeStub = async (stub: RpcStub<BeelayApi>) => {
    try {
      const disposable = stub as unknown as DisposableStub;
      const disposer = disposable[symbolDispose];
      if (typeof disposer === 'function') {
        disposer.call(stub);
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
    if (subscriptionActiveRef.current) {
      await unsubscribeFromRpc();
    }

    setCurrentChannel(channel);
    currentChannelRef.current = channel;
    setConnectionStatus('connecting');
    addLog(`🔌 Opening RPC session for channel ${channel.name}`);

    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL || "ws://localhost:8787";
      const rpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      rpcRef.current = rpc;
      addLog(`🌐 Created WebSocket RPC stub targeting ${workerUrl}`);

      rpc.onRpcBroken((error) => {
        const reason = error?.message ?? String(error ?? 'unknown');
        addLog(`❌ RPC connection broke: ${reason}`);
        setConnectionStatus(reason.includes('disposing the main stub') ? 'disconnected' : 'error');
      });

      try {
        const handshake = await rpc.hello('webui-handshake');
        addLog(`🤝 Handshake response: ${handshake}`);
      } catch (handshakeError) {
        addLog(`❌ RPC handshake failed: ${handshakeError}`);
        setConnectionStatus('error');
        throw handshakeError;
      }

      let activeChannel: Channel = channel;

      if (channel.docId.startsWith('temp-') || channel.docId.startsWith('channel-')) {
        const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
        const result = await rpc.createDoc({
          initialCommit,
          otherParents: []
        });
        const newDocId = result.id;
        await sqliteService.updateChannelDocId(channel.id, newDocId);
        setChannels(prev => prev.map(c => c.id === channel.id ? { ...c, docId: newDocId } : c));
        activeChannel = { ...channel, docId: newDocId };
        setCurrentChannel(activeChannel);
        currentChannelRef.current = activeChannel;
      } else {
        try {
          await rpc.loadDocument(channel.docId);
        } catch {
          const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
          const result = await rpc.createDoc({
            initialCommit,
            otherParents: []
          });
          const newDocId = result.id;
          await sqliteService.updateChannelDocId(channel.id, newDocId);
          setChannels(prev => prev.map(c => c.id === channel.id ? { ...c, docId: newDocId } : c));
          activeChannel = { ...channel, docId: newDocId };
          setCurrentChannel(activeChannel);
          currentChannelRef.current = activeChannel;
        }
      }

      setConnectionStatus('connected');
      addLog(`📡 Connected to channel: ${activeChannel.name}`);

      const channelMessages = await sqliteService.getMessagesForChannel(activeChannel.id);
      setMessages(channelMessages);
      processedCommitHashesRef.current = new Set(channelMessages.map(message => message.commitHash));

      await subscribeToRpc(activeChannel.docId);

    } catch (error) {
      addLog(`❌ Error connecting to channel: ${error}`);
      setConnectionStatus('error');
    }
  };

  const sendMessage = async () => {
    const content = messageInput.trim();
    if (!content) {
      addLog('ℹ️ Cannot send: message is empty');
      return;
    }

    if (!userName.trim()) {
      addLog('ℹ️ Cannot send: set your name first');
      return;
    }

    if (!currentChannel) {
      addLog('ℹ️ Cannot send: no channel selected');
      return;
    }

    if (!currentChannel.docId) {
      addLog('ℹ️ Cannot send: channel is still provisioning');
      return;
    }

    if (!rpcRef.current) {
      addLog('ℹ️ Cannot send: RPC connection not ready');
      return;
    }

    try {
      const messageContent = {
        user: userName.trim(),
        content,
        timestamp: Date.now()
      };

      // Add commit via worker
      addLog('➡️ Sending message via RPC');
      const result = await rpcRef.current.addWorkerCommit(currentChannel.docId as string, JSON.stringify(messageContent));
      addLog(`⬅️ RPC response: ${JSON.stringify(result)}`);

      if (result.success) {
        addLog(`🔗 Raw CRDT: hash=${result.commitHash}, content=${JSON.stringify(messageContent)}`);
        setMessageInput('');
        addLog('📡 Commit accepted by worker, awaiting broadcast echo');
      } else {
        addLog('⚠️ addWorkerCommit did not report success');
        addLog(`❌ Failed to add commit`);
      }

    } catch (error) {
      addLog(`❌ Error sending message: ${error}`);
    }
  };

  const leaveChannel = async () => {
    await unsubscribeFromRpc();
    if (rpcRef.current) {
      await disposeStub(rpcRef.current);
      rpcRef.current = null;
    }
    setCurrentChannel(null);
    currentChannelRef.current = null;
    setMessages([]);
    processedCommitHashesRef.current.clear();
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