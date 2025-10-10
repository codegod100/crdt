<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { newWebSocketRpcSession, type RpcStub, RpcTarget } from 'capnweb';
  import {
    sqliteService,
    type Channel,
    type Message,
    type ChannelDocumentCommit
  } from '$lib/services/sqliteService';

  const symbolDispose: symbol = typeof (Symbol as { dispose?: symbol }).dispose === 'symbol'
    ? (Symbol as { dispose: symbol }).dispose
    : Symbol.for('Symbol.dispose');

  type DisposableStub = {
    [symbolDispose]?: () => void;
  };

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
    createDoc(_options: CreateDocOptions): Promise<CreateDocResult>;
    loadDocument(_docId: string): Promise<CommitSnapshot[]>;
    addCommits(_options: unknown): Promise<{ success: boolean }>;
    addWorkerCommit(_docId: string, _content: string): Promise<{ success: boolean; commitHash: string }>;
    createContactCard(): Promise<{ card: string }>;
    createStream(_options: unknown): Promise<{ streamId: string }>;
    waitUntilSynced(_peerId: string): Promise<{ synced: boolean }>;
    stop(): Promise<void>;
    hello(_name: string): Promise<string>;
    registerClientTarget(_target: RpcTarget, _docId?: string): Promise<{ success: boolean }>;
    unregisterClientTarget(_target: RpcTarget, _docId?: string): Promise<{ success: boolean }>;
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

    if (typeof data === 'string') {
      try {
        return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } catch {
        return new TextEncoder().encode(data);
      }
    }

    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }

    throw new Error('Unsupported commit contents format');
  }

  async function createCommit(content: string, parents: string[] = []): Promise<CommitSnapshot> {
    const contents = encodeUtf8(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', contents.buffer as ArrayBuffer);
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      parents,
      hash,
      contents
    };
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
        payload = JSON.parse(commitText) as {
          type?: string;
          user?: string;
          content?: unknown;
          timestamp?: number;
        };
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

  let logs: string[] = [];
  let connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  let channels: Channel[] = [];
  let messages: Message[] = [];
  let sqliteInitialized = false;
  let currentChannel: Channel | null = null;
  let userName = '';
  let messageInput = '';
  let joinAddressInput = '';
  let newChannelName = '';
  let activeView: 'chat' | 'document' = 'document';
  let documentContent = '';
  let lastDocumentSync: number | null = null;
  let isDocumentSyncing = false;
  let documentHistory: DocumentCommitEntry[] = [];
  let historyIndex: number | null = null;
  let charAttribution: CharAttribution[] = [];
  let authorColors: Record<string, string> = {};

  let rpc: RpcStub<BeelayApi> | null = null;
  let clientTarget: ClientEventTarget | null = null;
  let textareaRef: HTMLTextAreaElement | null = null;
  let cursorPosition: { start: number; end: number } | null = null;
  let subscriptionActive = false;
  let subscriptionDocId: string | null = null;
  let currentChannelRef: Channel | null = null;
  let processedCommitHashes = new SvelteSet<string>();
  let documentDebounce: ReturnType<typeof setTimeout> | null = null;
  let applyingRemoteDocument = false;
  let latestDocumentContent = '';
  let authorColorIndex = 0;
  let restoreAttribution: CharAttribution[] | null = null;
  let historyLength = 0;
  let sliderMax = 0;
  let sliderValue = 0;
  let effectiveHistoryIndex: number | null = null;
  let selectedTimelineEntry: DocumentCommitEntry | null = null;
  let isTimeTravelMode = false;
  let effectiveContent = '';
  let textareaValue = '';
  let canEditDocument = false;
  let formattedDocumentSync = 'Never';
  let timelinePositionLabel = '—';
  let timelineStatusLabel = 'No commits yet';
  let legendEntries: [string, string][] = [];
  let showTimeline = false;
  let showLegend = false;
  let fallbackUserName = 'anonymous';
  let fallbackAttribution: CharAttribution[] = [];
  let overlayAttribution: CharAttribution[] = [];
  let overlayLines: LineSegment[][] = [];
  let overlayEmphasis = 0.18;

  const registerAuthor = (rawUser: string) => {
    const user = rawUser?.trim() || 'anonymous';
    if (authorColors[user]) {
      return;
    }
    const color = AUTHOR_COLORS[authorColorIndex % AUTHOR_COLORS.length];
    authorColorIndex += 1;
    authorColors = {
      ...authorColors,
      [user]: color
    };
  };

  const addLog = (message: string) => {
    logs = [...logs, `${new Date().toLocaleTimeString()}: ${message}`];
  };

  const ensureClientTarget = () => {
    if (!clientTarget) {
      clientTarget = new ClientEventTarget(handleServerEvent);
    }
    return clientTarget;
  };

  const disposeStub = async (stub: RpcStub<BeelayApi>) => {
    try {
      const disposable = stub as unknown as DisposableStub;
      const disposer = disposable[symbolDispose];
      if (typeof disposer === 'function') {
        disposer.call(stub);
      }
    } catch {
      console.log('Disposal completed');
    }
  };

  const subscribeToRpc = async (docId: string) => {
    if (!rpc) {
      addLog('⚠️  Cannot subscribe: RPC connection missing');
      return;
    }

    if (subscriptionActive && subscriptionDocId === docId) {
      return;
    }

    try {
      const target = ensureClientTarget();
      await rpc.registerClientTarget(target, docId);
      subscriptionActive = true;
      subscriptionDocId = docId;
      addLog('🔔 Subscribed to RPC updates');
    } catch (error) {
      subscriptionActive = false;
      subscriptionDocId = null;
      addLog(`❌ Failed to subscribe to RPC updates: ${error}`);
    }
  };

  const unsubscribeFromRpc = async () => {
    if (!subscriptionActive || !rpc || !clientTarget) {
      subscriptionActive = false;
      subscriptionDocId = null;
      return;
    }

    try {
      await rpc.unregisterClientTarget(clientTarget, subscriptionDocId ?? undefined);
      addLog('🔕 Unsubscribed from RPC updates');
    } catch (error) {
      addLog(`⚠️  Failed to unsubscribe from RPC updates cleanly: ${error}`);
    } finally {
      subscriptionActive = false;
      subscriptionDocId = null;
    }
  };

  const addDocumentCommitToHistory = (entry: DocumentCommitEntry) => {
    if (documentHistory.some((existing) => existing.commitHash === entry.commitHash)) {
      return;
    }
    documentHistory = [...documentHistory, entry].sort((a, b) => a.timestamp - b.timestamp);
    registerAuthor(entry.user);
  };

  const processCommitEvent = async (docId: string, commitPayload: ServerCommitPayload) => {
    if (!currentChannelRef || currentChannelRef.docId !== docId) {
      return;
    }

    try {
      const contentArray = toUint8Array(commitPayload.contents);
      const decoded = new TextDecoder().decode(contentArray);
      const messageData = JSON.parse(decoded) as {
        type?: string;
        user?: string;
        content?: unknown;
        timestamp?: number;
      };
      const commitHash = commitPayload.hash;

      if (processedCommitHashes.has(commitHash)) {
        return;
      }

      const payloadType = typeof messageData.type === 'string' ? messageData.type : 'message';

      if (payloadType === 'document') {
        if (typeof messageData.content !== 'string') {
          addLog(`⚠️  Document commit missing textual content: ${decoded}`);
          processedCommitHashes.add(commitHash);
          return;
        }

        if (textareaRef) {
          cursorPosition = {
            start: textareaRef.selectionStart,
            end: textareaRef.selectionEnd
          };
        }

        const oldContent = latestDocumentContent;
        const newContent = messageData.content;
        const lengthDiff = newContent.length - oldContent.length;

        if (cursorPosition) {
          cursorPosition = {
            start: Math.max(0, cursorPosition.start + lengthDiff),
            end: Math.max(0, cursorPosition.end + lengthDiff)
          };
        }

        applyingRemoteDocument = true;
        documentContent = newContent;
        latestDocumentContent = newContent;
        if (documentDebounce) {
          clearTimeout(documentDebounce);
          documentDebounce = null;
        }
        const updatedAt = messageData.timestamp ?? Date.now();
        lastDocumentSync = updatedAt;

        await sqliteService.saveChannelDocument({
          channelId: currentChannelRef.id,
          content: messageData.content,
          updatedAt,
          latestCommitHash: commitHash
        });

        const user = messageData.user?.trim() || 'anonymous';
        const commitRecord: ChannelDocumentCommit = {
          channelId: currentChannelRef.id,
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

        processedCommitHashes.add(commitHash);
        setTimeout(() => {
          applyingRemoteDocument = false;
        }, 0);
        addLog(`📄 Document update ${commitHash.substring(0, 8)} applied`);
        return;
      }

      if (!messageData.user || typeof messageData.content !== 'string') {
        addLog(`⚠️  Received commit with unexpected payload: ${decoded}`);
        processedCommitHashes.add(commitHash);
        return;
      }

      const message: Message = {
        id: `msg-${commitHash}`,
        channelId: currentChannelRef.id,
        user: messageData.user,
        content: messageData.content,
        timestamp: messageData.timestamp ?? Date.now(),
        commitHash
      };

      const inserted = await sqliteService.saveMessage(message);

      if (!messages.find((m) => m.commitHash === commitHash)) {
        messages = [...messages, message].sort((a, b) => a.timestamp - b.timestamp);
      }

      if (!inserted && processedCommitHashes.has(commitHash)) {
        addLog(`↪️ Skipped duplicate commit ${commitHash.substring(0, 8)}`);
      } else {
        addLog(`📥 Received message commit ${commitHash.substring(0, 8)} from RPC`);
      }

      processedCommitHashes.add(commitHash);
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
        if (typeof event.id === 'string' && currentChannelRef && currentChannelRef.docId === event.id) {
          addLog(`📄 Document confirmed created: ${event.id}`);
        }
        break;
      default:
        addLog(`ℹ️ Received unhandled server event: ${JSON.stringify(event)}`);
    }
  };

  const createChannel = async (channelName: string) => {
    if (!channelName.trim() || !sqliteInitialized) return null;

    try {
      const channel = await sqliteService.createChannel(channelName.trim());
      channels = [channel, ...channels];
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

    const existingChannel = channels.find((c) => c.docId === address);
    if (existingChannel) {
      addLog(`✅ Channel for address ${address.substring(0, 8)}... already exists. Selecting it.`);
      await selectChannel(existingChannel);
      return;
    }

    addLog(`🔎 Trying to join new channel by address: ${address.substring(0, 8)}...`);
    let tempRpc: RpcStub<BeelayApi> | null = null;
    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL || 'ws://localhost:8787';
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
        // ignore
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

      channels = [hydratedChannel, ...channels];
      await selectChannel(hydratedChannel);
    } catch (error) {
      addLog(`❌ Error joining channel by address: ${error}`);
    } finally {
      if (tempRpc) {
        await disposeStub(tempRpc);
      }
    }
  };

  async function selectChannel(channel: Channel) {
    if (subscriptionActive) {
      await unsubscribeFromRpc();
    }

    currentChannel = channel;
    currentChannelRef = channel;
    documentContent = '';
    latestDocumentContent = '';
    documentHistory = [];
    historyIndex = null;
    charAttribution = [];
    authorColors = {};
    authorColorIndex = 0;
    activeView = 'document';
    connectionStatus = 'connecting';
    addLog(`🔌 Opening RPC session for channel ${channel.name}`);

    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL || 'ws://localhost:8787';
      const newRpc = newWebSocketRpcSession<BeelayApi>(workerUrl);
      rpc = newRpc;
      addLog(`🌐 Created WebSocket RPC stub targeting ${workerUrl}`);

      rpc.onRpcBroken((error) => {
        const reason = error?.message ?? String(error ?? 'unknown');
        addLog(`❌ RPC connection broke: ${reason}`);
        connectionStatus = reason.includes('disposing the main stub') ? 'disconnected' : 'error';
      });

      let preloadCommits: CommitSnapshot[] | null = null;

      try {
        const handshake = await newRpc.hello('webui-handshake');
        addLog(`🤝 Handshake response: ${handshake}`);
      } catch (handshakeError) {
        addLog(`❌ RPC handshake failed: ${handshakeError}`);
        connectionStatus = 'error';
        throw handshakeError;
      }

      let activeChannel: Channel = channel;

      if (channel.docId.startsWith('temp-') || channel.docId.startsWith('channel-')) {
        const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
        const result = await newRpc.createDoc({
          initialCommit,
          otherParents: []
        });
        const newDocId = result.id;
        await sqliteService.updateChannelDocId(channel.id, newDocId);
        channels = channels.map((c) => (c.id === channel.id ? { ...c, docId: newDocId } : c));
        activeChannel = { ...channel, docId: newDocId };
        currentChannel = activeChannel;
        currentChannelRef = activeChannel;
      } else {
        try {
          preloadCommits = await newRpc.loadDocument(channel.docId);
        } catch {
          const initialCommit = await createCommit(JSON.stringify({ type: 'init', channel: channel.name }), []);
          const result = await newRpc.createDoc({
            initialCommit,
            otherParents: []
          });
          const newDocId = result.id;
          await sqliteService.updateChannelDocId(channel.id, newDocId);
          channels = channels.map((c) => (c.id === channel.id ? { ...c, docId: newDocId } : c));
          activeChannel = { ...channel, docId: newDocId };
          currentChannel = activeChannel;
          currentChannelRef = activeChannel;
          preloadCommits = [];
        }
      }

      connectionStatus = 'connected';
      addLog(`📡 Connected to channel: ${activeChannel.name}`);

      let storedDocument = await sqliteService.getChannelDocument(activeChannel.id);
      let commitHistory = await sqliteService.getChannelDocumentCommits(activeChannel.id);

      if (!storedDocument && preloadCommits && preloadCommits.length > 0) {
        addLog('📥 Local document not found. Hydrating from worker history…');
        const persistResult = await persistCommitsForChannel(activeChannel, preloadCommits);
        if (persistResult.messageCount || persistResult.documentCount) {
          addLog(`📦 Imported ${persistResult.messageCount} message(s) and ${persistResult.documentCount} document revision(s).`);
          channels = channels.map((c) =>
            c.id === activeChannel.id ? { ...c, lastModified: persistResult.latestActivity } : c
          );
        }
        storedDocument = await sqliteService.getChannelDocument(activeChannel.id);
        commitHistory = await sqliteService.getChannelDocumentCommits(activeChannel.id);
      }

      const channelMessages = await sqliteService.getMessagesForChannel(activeChannel.id);
      messages = channelMessages;
  processedCommitHashes = new SvelteSet(channelMessages.map((message) => message.commitHash));

      const mappedHistory: DocumentCommitEntry[] = commitHistory
        .map((commit) => ({
          commitHash: commit.commitHash,
          user: commit.user?.trim() || 'anonymous',
          content: commit.content,
          timestamp: commit.timestamp
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      mappedHistory.forEach((entry) => processedCommitHashes.add(entry.commitHash));

      documentHistory = mappedHistory;
      mappedHistory.forEach((entry) => registerAuthor(entry.user));
      historyIndex = null;

      applyingRemoteDocument = true;
      const initialDocumentContent = storedDocument?.content ?? '';
      documentContent = initialDocumentContent;
      latestDocumentContent = initialDocumentContent;
      lastDocumentSync = storedDocument?.updatedAt ?? null;
      setTimeout(() => {
        applyingRemoteDocument = false;
      }, 0);

      await subscribeToRpc(activeChannel.docId);
    } catch (error) {
      addLog(`❌ Error connecting to channel: ${error}`);
      connectionStatus = 'error';
    }
  }

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

    if (!rpc) {
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

      addLog('➡️ Sending message via RPC');
      const result = await rpc.addWorkerCommit(currentChannel.docId as string, JSON.stringify(messageContent));
      addLog(`⬅️ RPC response: ${JSON.stringify(result)}`);

      if (result.success) {
        addLog(`🔗 Raw CRDT: hash=${result.commitHash}, content=${JSON.stringify(messageContent)}`);
        messageInput = '';
        addLog('📡 Commit accepted by worker, awaiting broadcast echo');
      } else {
        addLog('⚠️ addWorkerCommit did not report success');
        addLog('❌ Failed to add commit');
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

    if (!rpc) {
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
      isDocumentSyncing = true;
      addLog('📝 Sending document update via RPC');
      const result = await rpc.addWorkerCommit(currentChannel.docId, JSON.stringify(payload));
      addLog(`📨 Document RPC response: ${JSON.stringify(result)}`);
    } catch (error) {
      addLog(`❌ Error syncing document: ${error}`);
    } finally {
      isDocumentSyncing = false;
    }
  };

  const scheduleDocumentSync = (content: string) => {
    if (documentDebounce) {
      clearTimeout(documentDebounce);
    }

    documentDebounce = setTimeout(() => {
      void sendDocumentUpdate(content);
    }, 500);
  };

  const handleHistorySliderChange = (nextIndex: number) => {
    if (!documentHistory.length) {
      return;
    }

    const boundedIndex = Math.max(0, Math.min(nextIndex, documentHistory.length - 1));

    if (boundedIndex >= documentHistory.length - 1) {
      historyIndex = null;
    } else {
      historyIndex = boundedIndex;
    }
  };

  const handleHistorySliderInput = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement | null;
    if (!target) {
      return;
    }
    const value = Number.parseInt(target.value, 10);
    if (Number.isNaN(value)) {
      return;
    }
    handleHistorySliderChange(value);
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
      restoreAttribution = computeCharAttribution(subset);
    }

    historyIndex = null;
    documentContent = entry.content;
    latestDocumentContent = entry.content;
    registerAuthor(userName.trim() || entry.user);
    scheduleDocumentSync(entry.content);
  };

  const handleDocumentInput = (event: Event) => {
    const target = event.currentTarget as HTMLTextAreaElement;
    const value = target.value;
    cursorPosition = {
      start: target.selectionStart,
      end: target.selectionEnd
    };

    documentContent = value;
    if (applyingRemoteDocument) {
      return;
    }
    registerAuthor(userName.trim() || 'anonymous');
    scheduleDocumentSync(value);
  };

  const handleMessageInputKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handleJoinKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = (event.currentTarget as HTMLInputElement).value;
      void joinChannelByAddress(value);
      joinAddressInput = '';
    }
  };

  const handleCreateKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createChannel(newChannelName);
      newChannelName = '';
    }
  };

  const handleChannelKeyDown = (event: KeyboardEvent, channel: Channel) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    void selectChannel(channel);
  };

  const leaveChannel = async () => {
    await unsubscribeFromRpc();
    if (rpc) {
      await disposeStub(rpc);
      rpc = null;
    }
    currentChannel = null;
    currentChannelRef = null;
    messages = [];
    processedCommitHashes.clear();
    connectionStatus = 'disconnected';
    activeView = 'chat';
    documentContent = '';
    latestDocumentContent = '';
    documentHistory = [];
    historyIndex = null;
    charAttribution = [];
    authorColors = {};
    authorColorIndex = 0;
    lastDocumentSync = null;
    isDocumentSyncing = false;
    if (documentDebounce) {
      clearTimeout(documentDebounce);
      documentDebounce = null;
    }
    addLog('👋 Left channel');
  };

  onMount(async () => {
    try {
      await sqliteService.initialize();
      sqliteInitialized = true;
      addLog('✅ SQLite database initialized');

      try {
        const loadedChannels = await sqliteService.getAllChannels();
        channels = loadedChannels;
        if (loadedChannels.length > 0) {
          addLog(`📁 Found ${loadedChannels.length} existing channel(s)`);
        }
      } catch (error) {
        addLog(`⚠️  Could not load channels: ${error}`);
      }
    } catch (error) {
      addLog(`❌ Failed to initialize SQLite: ${error}`);
    }
  });

  onDestroy(() => {
    if (documentDebounce) {
      clearTimeout(documentDebounce);
    }
  });

  $: currentChannelRef = currentChannel;

  $: if (!documentHistory.length) {
    if (historyIndex !== null) {
      historyIndex = null;
    }
  } else if (historyIndex !== null && historyIndex > documentHistory.length - 1) {
    historyIndex = documentHistory.length - 1;
  }

  $: {
    const fallbackUser = userName.trim() || 'anonymous';

    if (restoreAttribution) {
      charAttribution = ensureAttributionMatchesContent(restoreAttribution, documentContent, fallbackUser);
      restoreAttribution = null;
    } else if (!documentHistory.length) {
      if (documentContent.length === 0) {
        charAttribution = [];
      } else {
        registerAuthor(fallbackUser);
        charAttribution = ensureAttributionMatchesContent([], documentContent, fallbackUser);
      }
    } else {
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

      charAttribution = finalAttribution;
    }
  }

  $: if (cursorPosition && textareaRef) {
    const newContentLength = textareaRef.value.length;
    textareaRef.selectionStart = Math.min(cursorPosition.start, newContentLength);
    textareaRef.selectionEnd = Math.min(cursorPosition.end, newContentLength);
    cursorPosition = null;
  }

  // Derived reactive values for template
  $: historyLength = documentHistory.length;
  $: sliderMax = historyLength > 0 ? historyLength - 1 : 0;
  $: sliderValue = historyLength > 0
    ? (historyIndex === null ? sliderMax : Math.max(0, Math.min(historyIndex, sliderMax)))
    : 0;
  $: effectiveHistoryIndex = historyLength > 0 ? sliderValue : null;
  $: selectedTimelineEntry = effectiveHistoryIndex !== null ? documentHistory[effectiveHistoryIndex] : null;
  $: isTimeTravelMode = historyLength > 0 && historyIndex !== null && historyIndex < historyLength - 1;
  $: effectiveContent = historyIndex === null ? documentContent : (selectedTimelineEntry?.content ?? documentContent);
  $: textareaValue = historyIndex === null ? documentContent : effectiveContent;
  $: canEditDocument = connectionStatus === 'connected' && Boolean(rpc) && !isTimeTravelMode;
  $: formattedDocumentSync = lastDocumentSync ? new Date(lastDocumentSync).toLocaleString() : 'Never';
  $: timelinePositionLabel = historyLength ? `${sliderValue + 1}/${historyLength}` : '—';
  $: timelineStatusLabel = selectedTimelineEntry
    ? `${selectedTimelineEntry.user} • ${formatTimestamp(selectedTimelineEntry.timestamp)}`
    : 'No commits yet';
  $: legendEntries = Object.entries(authorColors).sort((a, b) => a[0].localeCompare(b[0]));
  $: showTimeline = historyLength > 0;
  $: showLegend = legendEntries.length > 0;
  $: fallbackUserName = userName.trim() || 'anonymous';
  $: fallbackAttribution = arrayFromString(textareaValue).map((char) => ({
    char,
    author: fallbackUserName
  }));
  $: overlayAttribution = charAttribution.length > 0 ? charAttribution : fallbackAttribution;
  $: overlayLines = toOverlayLines(overlayAttribution, fallbackUserName);
  $: overlayEmphasis = isTimeTravelMode ? 0.28 : 0.18;

  const copyChannelAddress = async (docId: string, event?: Event) => {
    event?.stopPropagation();
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(docId);
      addLog('✅ Copied channel address to clipboard');
    }
  };
</script>

<div class="app">
  <header>
    <h1>CRDT Channel Chat</h1>
    <p>Real-time collaborative messaging with CRDT conflict resolution</p>
  </header>

  <main>
    <div class="chat-layout">
      <div class="channels-sidebar">
        <div class="channel-controls">
          <input
            type="text"
            placeholder="Your name"
            bind:value={userName}
            class="user-input"
          />
          <div class="create-channel">
            <input
              type="text"
              placeholder="New channel name"
              bind:value={newChannelName}
              on:keydown={handleCreateKeyDown}
              class="channel-input"
            />
            <button
              class="create-button"
              on:click={() => {
                void createChannel(newChannelName);
                newChannelName = '';
              }}
            >
              +
            </button>
          </div>
          <div class="join-channel">
            <input
              type="text"
              placeholder="Channel address"
              bind:value={joinAddressInput}
              on:keydown={handleJoinKeyDown}
              class="channel-input"
            />
            <button
              class="join-button"
              on:click={() => {
                void joinChannelByAddress(joinAddressInput);
                joinAddressInput = '';
              }}
            >
              Join
            </button>
          </div>
        </div>

        <div class="channels-list">
          <h3>Channels ({channels.length})</h3>
          {#each channels as channel (channel.id)}
            <div
              class="channel-item"
              class:active={currentChannel?.id === channel.id}
              role="button"
              tabindex="0"
              on:click={() => selectChannel(channel)}
              on:keydown={(event) => handleChannelKeyDown(event, channel)}
            >
              <div class="channel-name">#{channel.name}</div>
              <div class="channel-meta">{new Date(channel.lastModified).toLocaleDateString()}</div>
              <div class="channel-address">
                <input type="text" readonly value={channel.docId} />
                <button on:click={(event) => void copyChannelAddress(channel.docId, event)}>Copy</button>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="messages-area">
        {#if currentChannel}
          <div class="channel-content">
            <div class="channel-header">
              <h2>#{currentChannel.name}</h2>
              <div class="channel-actions">
                <div class="channel-tabs">
                  <button
                    type="button"
                    class="tab-button"
                    class:active={activeView === 'chat'}
                    on:click={() => (activeView = 'chat')}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    class="tab-button"
                    class:active={activeView === 'document'}
                    on:click={() => (activeView = 'document')}
                  >
                    Document
                  </button>
                </div>
                <button on:click={() => void leaveChannel()} class="leave-button">
                  Leave
                </button>
              </div>
            </div>

            {#if activeView === 'chat'}
              <div class="chat-view">
                <div class="messages-container">
                  {#if messages.length === 0}
                    <div class="empty-messages">
                      <p>No messages yet. Start the conversation!</p>
                    </div>
                  {:else}
                    {#each messages as message (message.id)}
                      <div class="message-item">
                        <div class="message-header">
                          <span class="message-user">{message.user}</span>
                          <span class="message-time">{new Date(message.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div class="message-content">{message.content}</div>
                      </div>
                    {/each}
                  {/if}
                </div>

                <div class="message-input-area">
                  <input
                    type="text"
                    bind:value={messageInput}
                    on:keydown={handleMessageInputKeyDown}
                    placeholder="Type a message..."
                    disabled={!userName.trim()}
                    class="message-input"
                  />
                  <button
                    class="send-button"
                    on:click={() => void sendMessage()}
                    disabled={!messageInput.trim() || !userName.trim()}
                  >
                    Send
                  </button>
                </div>
              </div>
            {:else}
              <div class="document-editor">
                <div class="document-toolbar">
                  <div class="document-status">
                    <strong>Last synced:</strong> {formattedDocumentSync}
                  </div>
                  <div class={`document-sync-indicator ${isDocumentSyncing ? 'syncing' : 'idle'}`}>
                    {isDocumentSyncing ? 'Syncing…' : 'Up to date'}
                  </div>
                </div>

                {#if showTimeline}
                  <div class="document-timeline">
                    <div class="timeline-slider">
                      <span class="timeline-label">History</span>
                      <input
                        type="range"
                        min={0}
                        max={sliderMax}
                        value={sliderValue}
                        on:input={handleHistorySliderInput}
                      />
                      <span class="timeline-position">{timelinePositionLabel}</span>
                    </div>
                    <div class="timeline-details">
                      <span class="timeline-status">{timelineStatusLabel}</span>
                      <div class="timeline-actions">
                        {#if isTimeTravelMode}
                          <button type="button" class="restore-button" on:click={handleRestoreVersion}>
                            Restore this version
                          </button>
                        {:else}
                          <span class="timeline-live">Live</span>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/if}

                <div class="document-editor-area">
                  <div class="document-overlay" aria-hidden="true">
                    {#each overlayLines as segments, lineIndex (lineIndex)}
                      <div class="overlay-line">
                        {#each segments as segment, segmentIndex (`${lineIndex}-${segmentIndex}`)}
                          <span
                            class="overlay-chunk"
                            style={`background-color: ${segment.text.length > 0 ? hexToRgba(authorColors[segment.author] ?? '#94a3b8', overlayEmphasis) : 'transparent'}`}
                          >
                            {segment.text || '\u00A0'}
                          </span>
                        {/each}
                      </div>
                    {/each}
                  </div>

                  <textarea
                    bind:this={textareaRef}
                    bind:value={textareaValue}
                    on:input={handleDocumentInput}
                    class="document-textarea"
                    placeholder="Share notes, ideas, and drafts together..."
                    disabled={!canEditDocument}
                  ></textarea>
                </div>

                {#if isTimeTravelMode}
                  <div class="timeline-warning">
                    Viewing an earlier revision. Restore this version or slide to the end to resume editing.
                  </div>
                {/if}

                {#if showLegend}
                  <div class="author-legend">
                    {#each legendEntries as [author, color] (author)}
                      <div class="legend-item">
                        <span class="legend-swatch" style={`background-color: ${color}`}></span>
                        <span class="legend-name">{author}</span>
                      </div>
                    {/each}
                  </div>
                {/if}

                <div class="document-hints">
                  {#if connectionStatus !== 'connected'}
                    Reconnect to sync live edits.
                  {:else if !userName.trim()}
                    Tip: add a display name so collaborators know who you are.
                  {:else if isTimeTravelMode}
                    You are in history view. Restore or move the slider to the end to resume live editing.
                  {:else}
                    Edits are saved automatically and shared with everyone in the channel.
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="welcome-screen">
            <h2>Welcome to CRDT Chat!</h2>
            <p>Select a channel from the sidebar to start chatting, or create a new one.</p>
            <div class="status">
              <span class={`status-indicator ${connectionStatus}`}>
                Status: {connectionStatus}
              </span>
              <span class={`status-indicator ${sqliteInitialized ? 'connected' : 'error'}`}>
                SQLite: {sqliteInitialized ? 'Ready' : 'Initializing...'}
              </span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="logs-container">
      <h3>Activity Log</h3>
      <div class="logs">
        {#if logs.length === 0}
          <p class="empty-logs">Activity will appear here</p>
        {:else}
          {#each logs as log, index (index)}
            <div class="log-entry">{log}</div>
          {/each}
        {/if}
      </div>
    </div>
  </main>
</div>
