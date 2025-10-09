//! WebAssembly bindings exposing the Subduction synchronization engine.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

use futures::{future::LocalBoxFuture, FutureExt};
use js_sys::{Math, Uint8Array};
use sedimentree_core::{
    future::Local,
    storage::MemoryStorage,
    Blob, Digest, LooseCommit, Sedimentree, SedimentreeId,
};
use serde::{Deserialize, Serialize};
use subduction_core::{connection::Connection, peer::id::PeerId, Subduction};
use wasm_bindgen::prelude::*;


thread_local! {
    static HANDLES: RefCell<HashMap<u32, HandleCtx>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u32> = RefCell::new(1);
}

#[wasm_bindgen]
pub struct Beelay {
    id: u32,
}

struct HandleCtx {
    documents: HashMap<String, DocumentCtx>,
}

struct DocumentCtx {
    sed_id: SedimentreeId,
    subduction: Subduction<Local, MemoryStorage, NullConnection>,
    commits: Vec<CommitRecord>,
    seen: HashSet<String>,
}

#[derive(Clone, Debug)]
struct CommitRecord {
    parents: Vec<String>,
    hash: String,
    contents: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDocArgs {
    #[serde(rename = "initialCommit")]
    initial_commit: CommitInput,
    #[serde(default)]
    _other_parents: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommitInput {
    parents: Vec<String>,
    hash: String,
    contents: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddCommitArgs {
    #[serde(rename = "docId")]
    doc_id: String,
    commits: Vec<CommitInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitOutput {
    #[serde(rename = "type")]
    kind: &'static str,
    parents: Vec<String>,
    hash: String,
    contents: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WaitResult {
    synced: bool,
}

#[wasm_bindgen]
impl Beelay {
    /// Mimics the original `Beelay.load` entrypoint and returns a handle to the runtime.
    #[wasm_bindgen(js_name = load)]
    pub async fn load(_config: JsValue) -> Result<Beelay, JsValue> {
        let id = NEXT_ID.with(|counter| {
            let mut c = counter.borrow_mut();
            let id = *c;
            *c += 1;
            id
        });

        HANDLES.with(|handles| {
            handles.borrow_mut().insert(
                id,
                HandleCtx {
                    documents: HashMap::new(),
                },
            );
        });

        Ok(Beelay { id })
    }

    /// Create a new document with the provided initial commit.
    #[wasm_bindgen(js_name = createDoc)]
    pub async fn create_doc(&self, args: JsValue) -> Result<JsValue, JsValue> {
        let args: CreateDocArgs = serde_wasm_bindgen::from_value(args)
            .map_err(JsValue::from)?;
    let doc_id = random_doc_id();
    let sed_id = SedimentreeId::new(random_bytes_array());

        let mut doc_ctx = DocumentCtx::new(sed_id);
        doc_ctx.apply_commit(&args.initial_commit).await?;

        HANDLES.with(|handles| {
            let mut handles = handles.borrow_mut();
            let ctx = handles
                .get_mut(&self.id)
                .ok_or_else(|| JsValue::from_str("invalid handle"))?;
            ctx.documents.insert(doc_id.clone(), doc_ctx);
            Ok::<_, JsValue>(())
        })?;

        Ok(JsValue::from_str(&doc_id))
    }

    /// Load all commits for a document.
    #[wasm_bindgen(js_name = loadDocument)]
    pub async fn load_document(&self, doc_id: String) -> Result<JsValue, JsValue> {
        HANDLES.with(|handles| {
            let handles = handles.borrow();
            let ctx = handles
                .get(&self.id)
                .ok_or_else(|| JsValue::from_str("invalid handle"))?;
            let doc = ctx
                .documents
                .get(&doc_id)
                .ok_or_else(|| JsValue::from_str("unknown document"))?;

            let commits = doc
                .commits
                .iter()
                .map(|record| CommitOutput {
                    kind: "commit",
                    parents: record.parents.clone(),
                    hash: record.hash.clone(),
                    contents: record.contents.clone(),
                })
                .collect::<Vec<_>>();

            serde_wasm_bindgen::to_value(&commits).map_err(JsValue::from)
        })
    }

    /// Add commits produced by a client.
    #[wasm_bindgen(js_name = addCommits)]
    pub async fn add_commits(&self, args: JsValue) -> Result<JsValue, JsValue> {
        let args: AddCommitArgs = serde_wasm_bindgen::from_value(args)
            .map_err(JsValue::from)?;
        let doc_id = args.doc_id.clone();

        let mut doc_ctx = HANDLES.with(|handles| {
            let mut handles = handles.borrow_mut();
            let ctx = handles
                .get_mut(&self.id)
                .ok_or_else(|| JsValue::from_str("invalid handle"))?;
            ctx.documents
                .remove(&doc_id)
                .ok_or_else(|| JsValue::from_str("unknown document"))
        })?;

        for commit in &args.commits {
            if let Err(err) = doc_ctx.apply_commit(commit).await {
                HANDLES.with(|handles| {
                    let mut handles = handles.borrow_mut();
                    let ctx = handles
                        .get_mut(&self.id)
                        .ok_or_else(|| JsValue::from_str("invalid handle"))?;
                    ctx.documents.insert(doc_id.clone(), doc_ctx);
                    Ok::<_, JsValue>(())
                })?;
                return Err(err);
            }
        }

        HANDLES.with(|handles| {
            let mut handles = handles.borrow_mut();
            let ctx = handles
                .get_mut(&self.id)
                .ok_or_else(|| JsValue::from_str("invalid handle"))?;
            ctx.documents.insert(doc_id, doc_ctx);
            serde_wasm_bindgen::to_value(&Vec::<serde_json::Value>::new())
                .map_err(JsValue::from)
        })
    }

    /// Graceful shutdown.
    pub fn stop(&self) {
        HANDLES.with(|handles| {
            handles.borrow_mut().remove(&self.id);
        });
    }

    /// Mock contact card support for compatibility with existing worker code.
    #[wasm_bindgen(js_name = createContactCard)]
    pub fn create_contact_card(&self) -> String {
        random_hex_string(32)
    }

    /// Wait until synced – no-op in the single-node WASM runtime.
    #[wasm_bindgen(js_name = waitUntilSynced)]
    pub async fn wait_until_synced(&self, _peer_id: String) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&WaitResult { synced: true })
            .map_err(JsValue::from)
    }
}

impl DocumentCtx {
    fn new(sed_id: SedimentreeId) -> Self {
        let tree = Sedimentree::new(Vec::new(), Vec::new());
        let subduction = Subduction::new(
            HashMap::from([(sed_id, tree)]),
            MemoryStorage::default(),
            HashMap::new(),
        );

        Self {
            sed_id,
            subduction,
            commits: Vec::new(),
            seen: HashSet::new(),
        }
    }

    async fn apply_commit(&mut self, commit: &CommitInput) -> Result<(), JsValue> {
        if !self.seen.insert(commit.hash.clone()) {
            return Ok(());
        }

        let blob = Blob::new(commit.contents.clone());
        let blob_meta = blob.meta();
        let parents = commit
            .parents
            .iter()
            .map(|parent| parse_digest(parent))
            .collect::<Result<Vec<_>, _>>()?;
        let digest = parse_digest(&commit.hash)?;
        let loose = LooseCommit::new(digest, parents, blob_meta);

        self.subduction
            .add_commit(self.sed_id, &loose, blob.clone())
            .await
            .map_err(|err| JsValue::from_str(&format!("{err:?}")))?;

        self.commits.push(CommitRecord {
            parents: commit.parents.clone(),
            hash: commit.hash.clone(),
            contents: commit.contents.clone(),
        });

        Ok(())
    }
}

fn parse_digest(hex_str: &str) -> Result<Digest, JsValue> {
    let bytes = hex::decode(hex_str)
        .map_err(|_| JsValue::from_str("digest must be 64 hex characters"))?;
    if bytes.len() != 32 {
        return Err(JsValue::from_str("digest must be 32 bytes"));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(Digest::from(arr))
}

fn random_doc_id() -> String {
    random_hex_string(16)
}

fn random_hex_string(length: usize) -> String {
    let bytes = random_bytes_vec(length);
    hex::encode(bytes)
}

fn random_bytes_array() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    fill_random_bytes(&mut bytes);
    bytes
}

fn random_bytes_vec(length: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; length];
    fill_random_bytes(&mut bytes);
    bytes
}

fn fill_random_bytes(buffer: &mut [u8]) {
    for byte in buffer.iter_mut() {
        *byte = random_u8();
    }
}

fn random_u8() -> u8 {
    (Math::random() * 256.0).floor() as u8
}

/// Minimal `Connection` implementation – the WASM runtime is single-node, so this is unused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NullConnection;

impl Connection<Local> for NullConnection {
    type DisconnectionError = std::convert::Infallible;
    type SendError = std::convert::Infallible;
    type RecvError = std::convert::Infallible;
    type CallError = std::convert::Infallible;

    fn peer_id(&self) -> PeerId {
        PeerId::new([0; 32])
    }

    fn disconnect(&mut self) -> LocalBoxFuture<'_, Result<(), Self::DisconnectionError>> {
        async { Ok(()) }.boxed_local()
    }

    fn send(
        &self,
        _message: subduction_core::connection::message::Message,
    ) -> LocalBoxFuture<'_, Result<(), Self::SendError>> {
        async { Ok(()) }.boxed_local()
    }

    fn recv(
        &self,
    ) -> LocalBoxFuture<'_, Result<subduction_core::connection::message::Message, Self::RecvError>> {
        async { std::future::pending().await }.boxed_local()
    }

    fn next_request_id(
        &self,
    ) -> LocalBoxFuture<'_, subduction_core::connection::message::RequestId> {
        async {
            subduction_core::connection::message::RequestId {
                requestor: self.peer_id(),
                nonce: 0,
            }
        }
        .boxed_local()
    }

    fn call(
        &self,
        _req: subduction_core::connection::message::BatchSyncRequest,
        _timeout: Option<std::time::Duration>,
    ) -> LocalBoxFuture<'_, Result<subduction_core::connection::message::BatchSyncResponse, Self::CallError>> {
        async { std::future::pending().await }.boxed_local()
    }
}

// -- Compatibility helpers --------------------------------------------------

/// Simple in-memory signer placeholder to reduce TypeScript churn.
#[wasm_bindgen]
pub struct MemorySigner {
    _opaque: bool,
}

#[wasm_bindgen]
impl MemorySigner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MemorySigner {
        MemorySigner { _opaque: false }
    }

    #[wasm_bindgen(js_name = verifyingKey)]
    pub fn verifying_key(&self) -> Uint8Array {
        Uint8Array::new_with_length(32)
    }

    #[wasm_bindgen(js_name = sign)]
    pub async fn sign(&self, message: Uint8Array) -> Uint8Array {
        // Echo the message – this signer is only used for demo/testing flows.
        message
    }
}

/// Minimal storage adapter placeholder for compatibility with the worker code.
#[wasm_bindgen]
pub struct MemoryStorageAdapter {
    _opaque: bool,
}


#[wasm_bindgen]
impl MemoryStorageAdapter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MemoryStorageAdapter {
        MemoryStorageAdapter { _opaque: false }
    }
}

#[wasm_bindgen(js_name = createMemoryStorageAdapter)]
pub fn create_memory_storage_adapter() -> MemoryStorageAdapter {
    MemoryStorageAdapter::new()
}
