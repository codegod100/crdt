/* tslint:disable */
/* eslint-disable */
export function parseBeelayDocId(val: string): DocumentId;

export type Config = {
    storage: StorageAdapter
    signer: Signer
}

export type StorageKey  = string[]
export type PeerId = string
export type DocumentId = string

export interface Signer {
    verifyingKey: Uint8Array
    sign(message: Uint8Array): Promise<Uint8Array>
}

export interface StorageAdapter {
  load(key: string[]): Promise<Uint8Array | undefined>
  loadRange(
    prefix: string[],
  ): Promise<Map<StorageKey, Uint8Array>>
  save(key: string[], data: Uint8Array): Promise<void>
  remove(key: string[]): Promise<void>
  listOneLevel(prefix: string[]): Promise<Array<string[]>>
}

export type Audience =
  | { type: "peerId"; peerId: PeerId }
  | { type: "serviceName"; serviceName: string }

export type StreamConfig =
  | { direction: "accepting"; receiveAudience?: string | null }
  | { direction: "connecting"; remoteAudience: Audience }

export interface Stream {
  on(event: "message", f: (msg: Uint8Array) => void): void
  off(event: "message", f: (msg: Uint8Array) => void): void
  on(event: "disconnect", f: () => void): void
  off(event: "disconnect", f: () => void): void
  closed(): Promise<void>
  recv(msg: Uint8Array): Promise<void>
  disconnect(): void
}

export type CommitHash = string

export type Commit = {
    hash: CommitHash,
    parents: CommitHash[],
    contents: Uint8Array,
}

export type Bundle = {
  start: CommitHash
  end: CommitHash
  checkpoints: CommitHash[]
  contents: Uint8Array
}

export type CommitOrBundle =
  | ({ type: "commit" } & Commit)
  | ({ type: "bundle" } & Bundle)

export type BundleSpec = {
    doc: DocumentId,
    start: CommitHash,
    end: CommitHash,
    checkpoints: CommitHash[],
}

export type Access = "pull" | "read" | "write" | "admin"

export type HexContactCard = string
export type Membered =
    | { type: "group", id: PeerId }
    | { type: "document", id: DocumentId }
export type KeyhiveEntity =
    | { type: "individual", contactCard: HexContactCard }
    | { type: "public" }
    | Membered

export type CreateDocArgs = {
    initialCommit: Commit,
    otherParents?: Array<KeyhiveEntity>,
}
export type CreateGroupArgs = {
    otherParents?: Array<KeyhiveEntity>,
}
export type AddMemberArgs =
    | { groupId: PeerId,
        member: KeyhiveEntity,
        access: Access,
    }
    | { docId: DocumentId,
        member: KeyhiveEntity,
        access: Access,
    }
export type RemoveMemberArgs =
    | { groupId: PeerId,
        member: KeyhiveEntity,
    }
    | { docId: DocumentId,
        member: KeyhiveEntity,
    }
export type AddCommitArgs = {
    docId: DocumentId,
    commits: Commit[],
}
export type AddBundleArgs = {
    docId: DocumentId,
    bundle: Bundle,
}

interface BeelayEvents {
    "peer-sync-state": {peerId: PeerId, status: "listening" | "connected"},
    "doc-event": {docId: DocumentId, event: {type: "data", data: CommitOrBundle } | { type: "discovered" }},
}
interface Beelay {
  on<T extends keyof BeelayEvents>(
    eventName: T,
    handler: (args: BeelayEvents[T]) => void,
  ): void;
  off<T extends keyof BeelayEvents>(
    eventName: T,
    handler: (args: BeelayEvents[T]) => void,
  ): void;
  createGroup(args?: CreateGroupArgs): Promise<PeerId>;
}


export class Beelay {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  static load(config: Config): Promise<Beelay>;
  createContactCard(): Promise<HexContactCard>;
  createDoc(args: CreateDocArgs): Promise<DocumentId>;
  addMember(args: AddMemberArgs): Promise<void>;
  removeMember(args: RemoveMemberArgs): Promise<void>;
  addCommits(args: AddCommitArgs): Promise<BundleSpec[]>;
  addBundle(args: AddBundleArgs): Promise<void>;
  loadDocument(doc_id: any): Promise<Array<CommitOrBundle> | null>;
  waitForDocument(doc_id: any): Promise<Array<CommitOrBundle>>;
  createStream(config: StreamConfig): Stream;
  stop(): Promise<void>;
  version(): string;
  waitUntilSynced(peer_id: PeerId): Promise<void>;
  isStopped(): boolean;
  readonly peerId: PeerId;
}
export class MemorySigner {
  free(): void;
  [Symbol.dispose](): void;
  constructor(signing_key?: Uint8Array | null);
  sign(message: Uint8Array): Promise<Uint8Array>;
  readonly verifyingKey: Uint8Array;
  readonly signingKey: Uint8Array;
}
export class MemoryStorageAdapter {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  load(key: any): Promise<any>;
  loadRange(prefix: any): Promise<any>;
  save(key: any, data: any): Promise<void>;
  remove(key: any): Promise<void>;
  listOneLevel(prefix: any): Promise<any>;
}
export class StreamHandle {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  on(event: any, callback: any): void;
  recv(msg: any): void;
  disconnect(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_memorysigner_free: (a: number, b: number) => void;
  readonly memorysigner_new: (a: number) => [number, number, number];
  readonly memorysigner_verifying_key: (a: number) => [number, number];
  readonly memorysigner_signing_key: (a: number) => [number, number];
  readonly memorysigner_sign: (a: number, b: number, c: number) => any;
  readonly __wbg_memorystorageadapter_free: (a: number, b: number) => void;
  readonly memorystorageadapter_new: () => number;
  readonly memorystorageadapter_load: (a: number, b: any) => any;
  readonly memorystorageadapter_loadRange: (a: number, b: any) => any;
  readonly memorystorageadapter_save: (a: number, b: any, c: any) => any;
  readonly memorystorageadapter_remove: (a: number, b: any) => any;
  readonly memorystorageadapter_listOneLevel: (a: number, b: any) => any;
  readonly __wbg_beelay_free: (a: number, b: number) => void;
  readonly beelay_load: (a: any) => any;
  readonly beelay_peer_id: (a: number) => any;
  readonly beelay_createContactCard: (a: number) => any;
  readonly beelay_createDoc: (a: number, b: any) => any;
  readonly beelay_createGroup: (a: number, b: any) => any;
  readonly beelay_addMember: (a: number, b: any) => any;
  readonly beelay_removeMember: (a: number, b: any) => any;
  readonly beelay_addCommits: (a: number, b: any) => any;
  readonly beelay_addBundle: (a: number, b: any) => any;
  readonly beelay_loadDocument: (a: number, b: any) => any;
  readonly beelay_waitForDocument: (a: number, b: any) => any;
  readonly beelay_createStream: (a: number, b: any) => [number, number, number];
  readonly beelay_stop: (a: number) => any;
  readonly beelay_on: (a: number, b: any, c: any) => [number, number];
  readonly beelay_off: (a: number, b: any, c: any) => [number, number];
  readonly beelay_version: (a: number) => [number, number];
  readonly beelay_waitUntilSynced: (a: number, b: any) => any;
  readonly beelay_isStopped: (a: number) => number;
  readonly parseBeelayDocId: (a: any) => [number, number, number];
  readonly __wbg_streamhandle_free: (a: number, b: number) => void;
  readonly streamhandle_on: (a: number, b: any, c: any) => [number, number];
  readonly streamhandle_recv: (a: number, b: any) => [number, number];
  readonly streamhandle_disconnect: (a: number) => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_6: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure1025_externref_shim: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen__convert__closures_____invoke__hfe40283d161268ce: (a: number, b: number) => void;
  readonly closure1638_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
