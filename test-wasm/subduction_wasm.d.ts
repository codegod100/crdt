/* tslint:disable */
/* eslint-disable */
export function createMemoryStorageAdapter(): MemoryStorageAdapter;
export class Beelay {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Mimics the original `Beelay.load` entrypoint and returns a handle to the runtime.
   */
  static load(_config: any): Promise<Beelay>;
  /**
   * Create a new document with the provided initial commit.
   */
  createDoc(args: any): Promise<any>;
  /**
   * Load all commits for a document.
   */
  loadDocument(doc_id: string): Promise<any>;
  /**
   * Add commits produced by a client.
   */
  addCommits(args: any): Promise<any>;
  /**
   * Graceful shutdown.
   */
  stop(): void;
  /**
   * Mock contact card support for compatibility with existing worker code.
   */
  createContactCard(): string;
  /**
   * Wait until synced – no-op in the single-node WASM runtime.
   */
  waitUntilSynced(_peer_id: string): Promise<any>;
}
/**
 * Simple in-memory signer placeholder to reduce TypeScript churn.
 */
export class MemorySigner {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  verifyingKey(): Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}
/**
 * Minimal storage adapter placeholder for compatibility with the worker code.
 */
export class MemoryStorageAdapter {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_beelay_free: (a: number, b: number) => void;
  readonly beelay_load: (a: any) => any;
  readonly beelay_createDoc: (a: number, b: any) => any;
  readonly beelay_loadDocument: (a: number, b: number, c: number) => any;
  readonly beelay_addCommits: (a: number, b: any) => any;
  readonly beelay_stop: (a: number) => void;
  readonly beelay_createContactCard: (a: number) => [number, number];
  readonly beelay_waitUntilSynced: (a: number, b: number, c: number) => any;
  readonly __wbg_memorysigner_free: (a: number, b: number) => void;
  readonly memorysigner_verifyingKey: (a: number) => any;
  readonly memorysigner_sign: (a: number, b: any) => any;
  readonly __wbg_memorystorageadapter_free: (a: number, b: number) => void;
  readonly createMemoryStorageAdapter: () => number;
  readonly memorystorageadapter_new: () => number;
  readonly memorysigner_new: () => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly closure50_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure96_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
