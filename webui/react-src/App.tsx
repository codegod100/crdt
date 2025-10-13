import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { newWebSocketRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { sqliteService, type Channel, type Message, type ChannelDocumentCommit } from './sqliteService'
import './App.css'

const symbolDispose: symbol = typeof (Symbol as { dispose?: symbol }).dispose === 'symbol'
  ? (Symbol as { dispose: symbol }).dispose
  : Symbol.for('Symbol.dispose')

type DisposableStub = {
  [symbolDispose]?: () => void
}

function resolveWorkerUrl(): string {
  const envUrl = import.meta.env.VITE_WORKER_URL;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl;
  }

  if (typeof window !== 'undefined') {
    const { protocol, hostname, host } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'ws://localhost:8787';
    }
    const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
    return `${wsProtocol}://${host}`;
  }

  return 'ws://localhost:8787';
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

interface DocumentCommitEntry {
  commitHash: string;
  user: string;
  content: string;
  timestamp: number;
}

interface CharAttribution {
  char: string;
  author: string;
}

interface LineSegment {
  author: string;
  text: string;
}

const AUTHOR_COLORS = [
  '#0ea5e9',
  '#ec4899',
  '#8b5cf6',
  '#22c55e',
  '#f97316',
  '#facc15',
  '#06b6d4',
  '#14b8a6'
];

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function hexToRgba(hex: string, alpha: number): string {
  let parsed = hex.replace('#', '');
  if (parsed.length === 3) {
    parsed = parsed.split('').map((char) => char + char).join('');
  }
  if (parsed.length !== 6) {
    return `rgba(148, 163, 184, ${alpha})`;
  }
  const r = parseInt(parsed.slice(0, 2), 16);
  const g = parseInt(parsed.slice(2, 4), 16);
  const b = parseInt(parsed.slice(4, 6), 16);
  return `rgba(${Number.isNaN(r) ? 148 : r}, ${Number.isNaN(g) ? 163 : g}, ${Number.isNaN(b) ? 184 : b}, ${alpha})`;
}

function arrayFromString(value: string): string[] {
  return Array.from(value);
}

function mergeAttribution(
  previous: CharAttribution[],
  nextChars: string[],
  fallbackAuthor: string
): CharAttribution[] {
  if (previous.length === 0) {
    return nextChars.map((char) => ({ char, author: fallbackAuthor }));
  }

  const prevChars = previous.map((item) => item.char);
  const prevLength = prevChars.length;
  const nextLength = nextChars.length;

  if (prevLength === 0) {
    return nextChars.map((char) => ({ char, author: fallbackAuthor }));
  }

  const dp: number[][] = Array.from({ length: prevLength + 1 }, () => new Array(nextLength + 1).fill(0));

  for (let i = prevLength - 1; i >= 0; i -= 1) {
    for (let j = nextLength - 1; j >= 0; j -= 1) {
      if (prevChars[i] === nextChars[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: CharAttribution[] = [];
  let i = 0;
  let j = 0;

  while (i < prevLength && j < nextLength) {
    if (prevChars[i] === nextChars[j]) {
      result.push({ char: nextChars[j], author: previous[i].author });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      result.push({ char: nextChars[j], author: fallbackAuthor });
      j += 1;
    }
  }

  while (j < nextLength) {
    result.push({ char: nextChars[j], author: fallbackAuthor });
    j += 1;
  }

  return result;
}

function computeCharAttribution(entries: DocumentCommitEntry[]): CharAttribution[] {
  let attribution: CharAttribution[] = [];

  for (const entry of entries) {
    if (!entry.content) {
      attribution = [];
      continue;
    }

    const chars = arrayFromString(entry.content);
    if (attribution.length === 0) {
      attribution = chars.map((char) => ({ char, author: entry.user }));
      continue;
    }

    attribution = mergeAttribution(attribution, chars, entry.user);
  }

  return attribution;
}

function ensureAttributionMatchesContent(
  base: CharAttribution[],
  content: string,
  fallbackAuthor: string
): CharAttribution[] {
  const contentChars = arrayFromString(content);
  if (base.length === 0 && contentChars.length === 0) {
    return [];
  }
  return mergeAttribution(base, contentChars, fallbackAuthor);
}

function toOverlayLines(attribution: CharAttribution[], fallbackAuthor: string): LineSegment[][] {
  if (attribution.length === 0) {
    return [[{ author: fallbackAuthor, text: '' }]];
  }

  const lines: LineSegment[][] = [];
  let segments: LineSegment[] = [];
  let current: LineSegment | null = null;

  const flushSegment = () => {
    if (current) {
      segments.push(current);
      current = null;
    }
  };

  const flushLine = (authorForEmpty: string) => {
    flushSegment();
    if (segments.length === 0) {
      segments.push({ author: authorForEmpty, text: '' });
    }
    lines.push(segments);
    segments = [];
  };

  for (const { char, author } of attribution) {
    if (char === '\n') {
      flushLine(author);
      continue;
    }

    if (!current || current.author !== author) {
      flushSegment();
      current = { author, text: char };
    } else {
      current.text += char;
    }
  }

  flushLine(attribution.at(-1)?.author ?? fallbackAuthor);

  return lines;
}

interface PersistResult {
  messageCount: number;
  documentCount: number;
  latestActivity: number;
  latestDocumentTimestamp: number;
  latestDocumentHash: string | null;
  latestDocumentContent: string;
}

async function persistCommitsForChannel(channel: Channel, commits: CommitSnapshot[]): Promise<PersistResult> {
  let messageCount = 0;
  let documentCount = 0;
  let latestActivity = channel.lastModified;
  let latestDocumentTimestamp = 0;
  let latestDocumentHash: string | null = null;
  let latestDocumentContent = '';

  const decoder = new TextDecoder();

  for (const commit of commits) {
    const payloadBytes = toUint8Array(commit.contents);
    const commitText = decoder.decode(payloadBytes);

    let payload: { type?: string; user?: string; content?: unknown; timestamp?: number } | null = null;
    try {
      payload = JSON.parse(commitText) as { type?: string; user?: string; content?: unknown; timestamp?: number };
    } catch {
      continue;
    }

    const type = typeof payload?.type === 'string' ? payload!.type : 'message';
    const timestamp = typeof payload?.timestamp === 'number' ? payload!.timestamp : Date.now();
    const user = payload?.user?.trim() || 'anonymous';

    latestActivity = Math.max(latestActivity, timestamp);

    if (type === 'document') {
      if (typeof payload?.content !== 'string') {
        continue;
      }

      await sqliteService.saveChannelDocumentCommit({
        channelId: channel.id,
        commitHash: commit.hash,
        user,
        content: payload.content,
        timestamp
      });

      latestDocumentTimestamp = Math.max(latestDocumentTimestamp, timestamp);
      latestDocumentHash = commit.hash;
      latestDocumentContent = payload.content;
      documentCount += 1;
      continue;
    }

    if (type === 'message') {
      if (typeof payload?.content !== 'string') {
        continue;
      }

      const message: Message = {
        id: `msg-${commit.hash}`,
        channelId: channel.id,
        user,
        content: payload.content,
        timestamp,
        commitHash: commit.hash
      };

      const inserted = await sqliteService.saveMessage(message);
      if (inserted) {
        messageCount += 1;
      }
    }
  }

  if (documentCount > 0) {
    await sqliteService.saveChannelDocument({
      channelId: channel.id,
      content: latestDocumentContent,
      updatedAt: latestDocumentTimestamp || Date.now(),
      latestCommitHash: latestDocumentHash
    });
  }

  if (latestActivity !== channel.lastModified) {
    await sqliteService.updateChannelLastModified(channel.id, latestActivity);
  }

  return {
    messageCount,
    documentCount,
    latestActivity,
    latestDocumentTimestamp,
    latestDocumentHash,
    latestDocumentContent
  };
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
  const [joinAddressInput, setJoinAddressInput] = useState('');
  const [activeView, setActiveView] = useState<'chat' | 'document'>('document');
  const [documentContent, setDocumentContent] = useState('');
  const [lastDocumentSync, setLastDocumentSync] = useState<number | null>(null);
  const [isDocumentSyncing, setIsDocumentSyncing] = useState(false);
  const [documentHistory, setDocumentHistory] = useState<DocumentCommitEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [charAttribution, setCharAttribution] = useState<CharAttribution[]>([]);
  const [authorColors, setAuthorColors] = useState<Record<string, string>>({});
  const rpcRef = useRef<RpcStub<BeelayApi> | null>(null);
  const clientTargetRef = useRef<ClientEventTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef<{ start: number; end: number } | null>(null);
  const restoreAttributionRef = useRef<CharAttribution[] | null>(null);
  const subscriptionActiveRef = useRef(false);
  const subscriptionDocIdRef = useRef<string | null>(null);
  const currentChannelRef = useRef<Channel | null>(null);
  const processedCommitHashesRef = useRef<Set<string>>(new Set());
  const documentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRemoteDocumentRef = useRef(false);
  const docCommitHashRef = useRef<string | null>(null);
  const latestDocumentContentRef = useRef('');
  const authorColorIndexRef = useRef(0);

  const registerAuthor = useCallback((rawUser: string) => {
    const user = rawUser?.trim() || 'anonymous';
    setAuthorColors((prev) => {
      if (prev[user]) {
        return prev;
      }
      const color = AUTHOR_COLORS[authorColorIndexRef.current % AUTHOR_COLORS.length];
      authorColorIndexRef.current += 1;
      return {
        ...prev,
        [user]: color
      };
    });
  }, []);

  const addDocumentCommitToHistory = useCallback((entry: DocumentCommitEntry) => {
    setDocumentHistory((prev) => {
      if (prev.some((existing) => existing.commitHash === entry.commitHash)) {
        return prev;
      }
      const next = [...prev, entry].sort((a, b) => a.timestamp - b.timestamp);
      return next;
    });
    registerAuthor(entry.user);
  }, [registerAuthor]);

  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  useEffect(() => {
    processedCommitHashesRef.current = new Set(messages.map(message => message.commitHash));
  }, [messages]);

  useEffect(() => {
    latestDocumentContentRef.current = documentContent;
  }, [documentContent]);

  useEffect(() => {
    if (!documentHistory.length) {
      if (historyIndex !== null) {
        setHistoryIndex(null);
      }
      return;
    }

    if (historyIndex !== null && historyIndex > documentHistory.length - 1) {
      setHistoryIndex(documentHistory.length - 1);
    }
  }, [documentHistory, historyIndex]);

  useEffect(() => {
    const fallbackUser = userName.trim() || 'anonymous';

    if (restoreAttributionRef.current) {
      const restored = ensureAttributionMatchesContent(restoreAttributionRef.current, documentContent, fallbackUser);
      restoreAttributionRef.current = null;
      setCharAttribution(restored);
      return;
    }

    if (!documentHistory.length) {
      if (documentContent.length === 0) {
        setCharAttribution([]);
        return;
      }

      registerAuthor(fallbackUser);
      setCharAttribution(ensureAttributionMatchesContent([], documentContent, fallbackUser));
      return;
    }

    const maxIndex = documentHistory.length - 1;
    const targetIndex = historyIndex === null ? maxIndex : Math.min(historyIndex, maxIndex);
    const subset = documentHistory.slice(0, targetIndex + 1);

    subset.forEach((entry) => registerAuthor(entry.user));

    const baseAttribution = computeCharAttribution(subset);
    const targetContent = historyIndex === null
      ? documentContent
      : subset[subset.length - 1]?.content ?? documentContent;

    const finalAttribution = ensureAttributionMatchesContent(baseAttribution, targetContent, fallbackUser);

    if (historyIndex === null) {
      registerAuthor(fallbackUser);
    }

    setCharAttribution(finalAttribution);
  }, [documentHistory, historyIndex, documentContent, userName, registerAuthor]);

  useEffect(() => () => {
    if (documentDebounceRef.current) {
      clearTimeout(documentDebounceRef.current);
    }
  }, []);

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
      const messageData = JSON.parse(decoded) as { type?: string; user?: string; content?: unknown; timestamp?: number };
      const commitHash = commitPayload.hash;

      if (processedCommitHashesRef.current.has(commitHash)) {
        return;
      }

      const payloadType = typeof messageData.type === 'string' ? messageData.type : 'message';

      if (payloadType === 'document') {
        if (typeof messageData.content !== 'string') {
          addLog(`⚠️  Document commit missing textual content: ${decoded}`);
          processedCommitHashesRef.current.add(commitHash);
          return;
        }

        const oldContent = latestDocumentContentRef.current;
        const newContent = messageData.content;
        let cursorStart = 0;
        let cursorEnd = 0;

        if (textareaRef.current) {
          cursorStart = textareaRef.current.selectionStart;
          cursorEnd = textareaRef.current.selectionEnd;
        }

        const lengthDiff = newContent.length - oldContent.length;

        cursorRef.current = {
          start: Math.max(0, cursorStart + lengthDiff),
          end: Math.max(0, cursorEnd + lengthDiff)
        };

        applyingRemoteDocumentRef.current = true;
        setDocumentContent(newContent);
        latestDocumentContentRef.current = newContent;
        if (documentDebounceRef.current) {
          clearTimeout(documentDebounceRef.current);
          documentDebounceRef.current = null;
        }
        docCommitHashRef.current = commitHash;
        const updatedAt = messageData.timestamp ?? Date.now();
        setLastDocumentSync(updatedAt);

        await sqliteService.saveChannelDocument({
          channelId: currentChannelRef.current.id,
          content: messageData.content,
          updatedAt,
          latestCommitHash: commitHash
        });

        const user = messageData.user?.trim() || 'anonymous';
        const commitRecord: ChannelDocumentCommit = {
          channelId: currentChannelRef.current.id,
          commitHash,
          user,
          content: messageData.content,
          timestamp: updatedAt
        };

        await sqliteService.saveChannelDocumentCommit(commitRecord);

        addDocumentCommitToHistory({
          commitHash,
          user,
          content: messageData.content,
          timestamp: updatedAt
        });

        processedCommitHashesRef.current.add(commitHash);
        setTimeout(() => {
          applyingRemoteDocumentRef.current = false;
        }, 0);
        addLog(`📄 Document update ${commitHash.substring(0, 8)} applied`);
        return;
      }

      if (!messageData.user || typeof messageData.content !== 'string') {
        addLog(`⚠️  Received commit with unexpected payload: ${decoded}`);
        processedCommitHashesRef.current.add(commitHash);
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

  const joinChannelByAddress = async (address: string) => {
    if (!address.trim()) {
      addLog('ℹ️ Channel address cannot be empty');
      return;
    }

    const existingChannel = channels.find(c => c.docId === address);
    if (existingChannel) {
      addLog(`✅ Channel for address ${address.substring(0, 8)}... already exists. Selecting it.`);
      await selectChannel(existingChannel);
      return;
    }

    addLog(`🔎 Trying to join new channel by address: ${address.substring(0, 8)}...`);
    let tempRpc: RpcStub<BeelayApi> | null = null;
    try {
      const workerUrl = resolveWorkerUrl();
      tempRpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      await tempRpc.hello('webui-join-lookup');

      const commits = await tempRpc.loadDocument(address);
      if (!commits || commits.length === 0) {
        throw new Error('No commits found for this document address.');
      }

      const initialCommitContent = toUint8Array(commits[0].contents);
      const decoded = new TextDecoder().decode(initialCommitContent);
      let messageData: { channel?: string } = {};
      try {
        messageData = JSON.parse(decoded) as { channel?: string };
      } catch {
        // ignore parse issues for init commit
      }

      const channelName = messageData.channel || `Channel ${address.substring(0, 6)}`;

      addLog(`👍 Found channel "${channelName}" from address. Creating local entry.`);

      const newChannel = await sqliteService.createChannel(channelName, address);
      const persistResult = await persistCommitsForChannel(newChannel, commits);

      const hydratedChannel: Channel = {
        ...newChannel,
        lastModified: persistResult.latestActivity
      };

      addLog(`📦 Synced ${persistResult.messageCount} message commit(s) and ${persistResult.documentCount} document commit(s) from worker.`);

      setChannels(prev => [hydratedChannel, ...prev]);
      await selectChannel(hydratedChannel);

    } catch (error) {
      addLog(`❌ Error joining channel by address: ${error}`);
    } finally {
      if (tempRpc) {
        await disposeStub(tempRpc);
      }
    }
  };

  const selectChannel = async (channel: Channel) => {
    if (subscriptionActiveRef.current) {
      await unsubscribeFromRpc();
    }

    setCurrentChannel(channel);
    currentChannelRef.current = channel;
    setDocumentContent('');
    latestDocumentContentRef.current = '';
    setDocumentHistory([]);
    setHistoryIndex(null);
  setCharAttribution([]);
    setAuthorColors({});
    authorColorIndexRef.current = 0;
    docCommitHashRef.current = null;
    setActiveView('document');
    setConnectionStatus('connecting');
    addLog(`🔌 Opening RPC session for channel ${channel.name}`);

    try {
      const workerUrl = resolveWorkerUrl();
      const rpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      rpcRef.current = rpc;
      addLog(`🌐 Created WebSocket RPC stub targeting ${workerUrl}`);

      rpc.onRpcBroken((error) => {
        const reason = error?.message ?? String(error ?? 'unknown');
        addLog(`❌ RPC connection broke: ${reason}`);
        setConnectionStatus(reason.includes('disposing the main stub') ? 'disconnected' : 'error');
      });

      let preloadCommits: CommitSnapshot[] | null = null;

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
          preloadCommits = await rpc.loadDocument(channel.docId);
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
          preloadCommits = [];
        }
      }

      setConnectionStatus('connected');
      addLog(`📡 Connected to channel: ${activeChannel.name}`);

      let storedDocument = await sqliteService.getChannelDocument(activeChannel.id);
      let commitHistory = await sqliteService.getChannelDocumentCommits(activeChannel.id);

      if (!storedDocument && (!commitHistory.length || !preloadCommits || preloadCommits.length === 0)) {
        addLog('📭 No local history available and nothing retrieved from worker. Waiting for live updates.');
      }

      if (!storedDocument && preloadCommits && preloadCommits.length > 0) {
        addLog('📥 Local document not found. Hydrating from worker history…');
        const persistResult = await persistCommitsForChannel(activeChannel, preloadCommits);
        if (persistResult.messageCount || persistResult.documentCount) {
          addLog(`📦 Imported ${persistResult.messageCount} message(s) and ${persistResult.documentCount} document revision(s).`);
          setChannels(prev => prev.map((c) => c.id === activeChannel.id ? { ...c, lastModified: persistResult.latestActivity } : c));
        }
        storedDocument = await sqliteService.getChannelDocument(activeChannel.id);
        commitHistory = await sqliteService.getChannelDocumentCommits(activeChannel.id);
      }

      const channelMessages = await sqliteService.getMessagesForChannel(activeChannel.id);
      setMessages(channelMessages);
      processedCommitHashesRef.current = new Set(channelMessages.map(message => message.commitHash));

      const mappedHistory: DocumentCommitEntry[] = commitHistory
        .map((commit) => ({
          commitHash: commit.commitHash,
          user: commit.user?.trim() || 'anonymous',
          content: commit.content,
          timestamp: commit.timestamp
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      mappedHistory.forEach((entry) => processedCommitHashesRef.current.add(entry.commitHash));

      setDocumentHistory(mappedHistory);
      mappedHistory.forEach((entry) => registerAuthor(entry.user));
      setHistoryIndex(null);

      applyingRemoteDocumentRef.current = true;
      const initialDocumentContent = storedDocument?.content ?? '';
      setDocumentContent(initialDocumentContent);
      latestDocumentContentRef.current = initialDocumentContent;
      docCommitHashRef.current = storedDocument?.latestCommitHash ?? null;
      const updatedSync = storedDocument?.updatedAt ?? null;
      setLastDocumentSync(updatedSync);
      setTimeout(() => {
        applyingRemoteDocumentRef.current = false;
      }, 0);

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
        type: 'message',
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

  const sendDocumentUpdate = async (content: string) => {
    if (!currentChannel) {
      addLog('ℹ️ Cannot sync document: no channel selected');
      return;
    }

    if (!currentChannel.docId) {
      addLog('ℹ️ Cannot sync document: channel is still provisioning');
      return;
    }

    if (!rpcRef.current) {
      addLog('ℹ️ Cannot sync document: RPC connection not ready');
      return;
    }

    const payload = {
      type: 'document',
      user: userName.trim() || 'anonymous',
      content,
      timestamp: Date.now()
    };

    registerAuthor(payload.user);

    try {
      setIsDocumentSyncing(true);
      addLog('📝 Sending document update via RPC');
      const result = await rpcRef.current.addWorkerCommit(currentChannel.docId, JSON.stringify(payload));
      addLog(`📨 Document RPC response: ${JSON.stringify(result)}`);
    } catch (error) {
      addLog(`❌ Error syncing document: ${error}`);
    } finally {
      setIsDocumentSyncing(false);
    }
  };

  const scheduleDocumentSync = (content: string) => {
    if (documentDebounceRef.current) {
      clearTimeout(documentDebounceRef.current);
    }

    documentDebounceRef.current = setTimeout(() => {
      void sendDocumentUpdate(content);
    }, 500);
  };

  const handleHistorySliderChange = (nextIndex: number) => {
    if (!documentHistory.length) {
      return;
    }

    const boundedIndex = Math.max(0, Math.min(nextIndex, documentHistory.length - 1));

    if (boundedIndex >= documentHistory.length - 1) {
      setHistoryIndex(null);
    } else {
      setHistoryIndex(boundedIndex);
    }
  };

  const handleRestoreVersion = () => {
    if (historyIndex === null || !documentHistory[historyIndex]) {
      return;
    }

    const entry = documentHistory[historyIndex];
    addLog(`⏪ Restoring document to ${entry.commitHash.substring(0, 8)} by ${entry.user}`);

    const subset = documentHistory.slice(0, historyIndex + 1);
    if (subset.length) {
      subset.forEach((item) => registerAuthor(item.user));
      restoreAttributionRef.current = computeCharAttribution(subset);
    }

    setHistoryIndex(null);
    setDocumentContent(entry.content);
    latestDocumentContentRef.current = entry.content;
    registerAuthor(userName.trim() || entry.user);
    scheduleDocumentSync(entry.content);
  };

  const handleDocumentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart, selectionEnd } = e.target;
    cursorRef.current = { start: selectionStart, end: selectionEnd };

    setDocumentContent(value);
    if (applyingRemoteDocumentRef.current) {
      return;
    }
    registerAuthor(userName.trim() || 'anonymous');
    scheduleDocumentSync(value);
  };

  useLayoutEffect(() => {
    if (cursorRef.current && textareaRef.current) {
      const newContentLength = textareaRef.current.value.length;
      const start = Math.min(cursorRef.current.start, newContentLength);
      const end = Math.min(cursorRef.current.end, newContentLength);
      textareaRef.current.selectionStart = start;
      textareaRef.current.selectionEnd = end;
      cursorRef.current = null;
    }
  });

  const historyLength = documentHistory.length;
  const sliderMax = historyLength > 0 ? historyLength - 1 : 0;
  const sliderValue = historyLength > 0
    ? (historyIndex === null ? sliderMax : Math.max(0, Math.min(historyIndex, sliderMax)))
    : 0;
  const effectiveHistoryIndex = historyLength > 0 ? sliderValue : null;
  const selectedTimelineEntry = effectiveHistoryIndex !== null ? documentHistory[effectiveHistoryIndex] : null;
  const isTimeTravelMode = historyLength > 0 && historyIndex !== null && historyIndex < historyLength - 1;
  const effectiveContent = historyIndex === null
    ? documentContent
    : (selectedTimelineEntry?.content ?? documentContent);
  const textareaValue = historyIndex === null ? documentContent : effectiveContent;
  const canEditDocument = connectionStatus === 'connected' && Boolean(rpcRef.current) && !isTimeTravelMode;
  const formattedDocumentSync = lastDocumentSync ? new Date(lastDocumentSync).toLocaleString() : 'Never';
  const timelinePositionLabel = historyLength ? `${sliderValue + 1}/${historyLength}` : '—';
  const timelineStatusLabel = selectedTimelineEntry ? `${selectedTimelineEntry.user} • ${formatTimestamp(selectedTimelineEntry.timestamp)}` : 'No commits yet';
  const legendEntries = Object.entries(authorColors).sort((a, b) => a[0].localeCompare(b[0]));
  const showTimeline = historyLength > 0;
  const showLegend = legendEntries.length > 0;
  const fallbackUserName = userName.trim() || 'anonymous';
  const fallbackAttribution = arrayFromString(textareaValue).map((char) => ({
    char,
    author: fallbackUserName
  }));
  const overlayAttribution = charAttribution.length > 0 ? charAttribution : fallbackAttribution;
  const overlayLines: LineSegment[][] = toOverlayLines(overlayAttribution, fallbackUserName);
  const overlayEmphasis = isTimeTravelMode ? 0.28 : 0.18;

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
    setActiveView('chat');
    setDocumentContent('');
    latestDocumentContentRef.current = '';
    setDocumentHistory([]);
    setHistoryIndex(null);
    setCharAttribution([]);
    setAuthorColors({});
    authorColorIndexRef.current = 0;
    docCommitHashRef.current = null;
    setLastDocumentSync(null);
    setIsDocumentSyncing(false);
    if (documentDebounceRef.current) {
      clearTimeout(documentDebounceRef.current);
      documentDebounceRef.current = null;
    }
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
              <div className="join-channel">
                <input
                  type="text"
                  placeholder="Channel address"
                  value={joinAddressInput}
                  onChange={(e) => setJoinAddressInput(e.target.value)}
                  className="channel-input"
                />
                <button
                  onClick={() => {
                    joinChannelByAddress(joinAddressInput);
                    setJoinAddressInput('');
                  }}
                  className="join-button"
                >
                  Join
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
                  <div className="channel-address">
                    <input type="text" readOnly value={channel.docId} />
                    <button onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(channel.docId);
                      addLog('✅ Copied channel address to clipboard');
                    }}>Copy</button>
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
                    <div className="channel-tabs">
                      <button
                        type="button"
                        className={`tab-button ${activeView === 'chat' ? 'active' : ''}`}
                        onClick={() => setActiveView('chat')}
                      >
                        Chat
                      </button>
                      <button
                        type="button"
                        className={`tab-button ${activeView === 'document' ? 'active' : ''}`}
                        onClick={() => setActiveView('document')}
                      >
                        Document
                      </button>
                    </div>
                    <button onClick={leaveChannel} className="leave-button">
                      Leave
                    </button>
                  </div>
                </div>

                {activeView === 'chat' ? (
                  <>
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
                  <div className="document-editor">
                    <div className="document-toolbar">
                      <div className="document-status">
                        <strong>Last synced:</strong> {formattedDocumentSync}
                      </div>
                      <div className={`document-sync-indicator ${isDocumentSyncing ? 'syncing' : 'idle'}`}>
                        {isDocumentSyncing ? 'Syncing…' : 'Up to date'}
                      </div>
                    </div>

                    {showTimeline && (
                      <div className="document-timeline">
                        <div className="timeline-slider">
                          <span className="timeline-label">History</span>
                          <input
                            type="range"
                            min={0}
                            max={sliderMax}
                            value={sliderValue}
                            onChange={(e) => handleHistorySliderChange(Number(e.target.value))}
                          />
                          <span className="timeline-position">{timelinePositionLabel}</span>
                        </div>
                        <div className="timeline-details">
                          <span className="timeline-status">{timelineStatusLabel}</span>
                          <div className="timeline-actions">
                            {isTimeTravelMode ? (
                              <button
                                type="button"
                                className="restore-button"
                                onClick={handleRestoreVersion}
                              >
                                Restore this version
                              </button>
                            ) : (
                              <span className="timeline-live">Live</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="document-editor-area">
                      <div className="document-overlay" aria-hidden="true">
                        {overlayLines.map((segments, lineIndex) => (
                          <div key={`overlay-line-${lineIndex}`} className="overlay-line">
                            {segments.map((segment, segmentIndex) => {
                              const baseColor = authorColors[segment.author] ?? '#94a3b8';
                              const tint = segment.text.length > 0
                                ? hexToRgba(baseColor, overlayEmphasis)
                                : 'transparent';
                              return (
                                <span
                                  key={`overlay-chunk-${lineIndex}-${segmentIndex}`}
                                  className="overlay-chunk"
                                  style={{ backgroundColor: tint }}
                                >
                                  {segment.text || '\u00A0'}
                                </span>
                              );
                            })}
                          </div>
                        ))}
                      </div>

                      <textarea
                        ref={textareaRef}
                        value={textareaValue}
                        onChange={handleDocumentChange}
                        className="document-textarea"
                        placeholder="Share notes, ideas, and drafts together..."
                        disabled={!canEditDocument}
                      />
                    </div>

                    {isTimeTravelMode && (
                      <div className="timeline-warning">
                        Viewing an earlier revision. Restore this version or slide to the end to resume editing.
                      </div>
                    )}

                    {showLegend && (
                      <div className="author-legend">
                        {legendEntries.map(([author, color]) => (
                          <div key={author} className="legend-item">
                            <span className="legend-swatch" style={{ backgroundColor: color }} />
                            <span className="legend-name">{author}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="document-hints">
                      {connectionStatus !== 'connected'
                        ? 'Reconnect to sync live edits.'
                        : !userName.trim()
                          ? 'Tip: add a display name so collaborators know who you are.'
                          : isTimeTravelMode
                            ? 'You are in history view. Restore or move the slider to the end to resume live editing.'
                            : 'Edits are saved automatically and shared with everyone in the channel.'}
                    </div>
                  </div>
                )}
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
