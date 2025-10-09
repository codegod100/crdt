use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use js_sys::Uint8Array;
use sedimentree_core::{
    blob::{Blob, BlobMeta, Digest},
    Sedimentree,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

static NEXT_DOC_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct CommitRecord {
    digest: Digest,
    parents: Vec<Digest>,
    blob_meta: BlobMeta,
    contents: Vec<u8>,
}

impl CommitRecord {
    fn to_loose_commit(&self) -> sedimentree_core::LooseCommit {
        sedimentree_core::LooseCommit::new(self.digest, self.parents.clone(), self.blob_meta)
    }

    fn to_output(&self) -> CommitOutput {
        CommitOutput {
            commit_type: "commit".to_string(),
            parents: self
                .parents
                .iter()
                .map(|digest| format!("{digest}"))
                .collect(),
            hash: format!("{}", self.digest),
            contents: self.contents.clone(),
        }
    }
}

struct Document {
    commits: Vec<CommitRecord>,
    tree: Sedimentree,
}

impl Document {
    fn new(initial: CommitRecord) -> Self {
        let mut tree = Sedimentree::new(Vec::new(), Vec::new());
        tree.add_commit(initial.to_loose_commit());
        Self {
            commits: vec![initial],
            tree,
        }
    }

    fn append_commit(&mut self, record: CommitRecord) -> bool {
        if self
            .tree
            .has_loose_commit(record.digest)
        {
            return false;
        }
        self.tree.add_commit(record.to_loose_commit());
        self.commits.push(record);
        true
    }
}

#[derive(Default)]
struct InnerState {
    documents: HashMap<String, Document>,
}

#[wasm_bindgen]
pub struct Beelay {
    state: Rc<RefCell<InnerState>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDocArgs {
    #[serde(rename = "initialCommit")]
    initial_commit: JsCommitInput,
}

#[derive(Deserialize)]
struct AddCommitsArgs {
    #[serde(rename = "docId")]
    doc_id: String,
    commits: Vec<JsCommitInput>,
}

#[derive(Deserialize)]
struct JsCommitInput {
    hash: String,
    parents: Vec<String>,
    contents: Vec<u8>,
}

#[derive(Serialize)]
struct CommitOutput {
    #[serde(rename = "type")]
    commit_type: String,
    parents: Vec<String>,
    hash: String,
    contents: Vec<u8>,
}

fn hex_to_digest(value: &str) -> Result<Digest, JsValue> {
    Digest::from_str(value).map_err(|_| JsValue::from_str("Invalid digest"))
}

fn parse_commit(input: JsCommitInput) -> Result<CommitRecord, JsValue> {
    let digest = hex_to_digest(&input.hash)?;
    let parents = input
        .parents
        .iter()
        .map(|parent| hex_to_digest(parent))
        .collect::<Result<Vec<_>, _>>()?;
    let blob_meta = BlobMeta::from_digest_size(digest, input.contents.len() as u64);
    Ok(CommitRecord {
        digest,
        parents,
        blob_meta,
        contents: input.contents,
    })
}

#[wasm_bindgen]
impl Beelay {
    #[wasm_bindgen(js_name = load)]
    pub fn load(_config: JsValue) -> Result<Beelay, JsValue> {
        Ok(Beelay {
            state: Rc::new(RefCell::new(InnerState::default())),
        })
    }

    #[wasm_bindgen(getter, js_name = peerId)]
    pub fn peer_id(&self) -> String {
        "subduction-peer".to_string()
    }

    #[wasm_bindgen(js_name = createDoc)]
    pub fn create_doc(&self, args: JsValue) -> Result<String, JsValue> {
        let parsed: CreateDocArgs = serde_wasm_bindgen::from_value(args)?;
        let record = parse_commit(parsed.initial_commit)?;
        let doc_id = format!("doc-{}", NEXT_DOC_ID.fetch_add(1, Ordering::SeqCst));
        let mut state = self.state.borrow_mut();
        state.documents.insert(doc_id.clone(), Document::new(record));
        Ok(doc_id)
    }

    #[wasm_bindgen(js_name = loadDocument)]
    pub fn load_document(&self, doc_id: String) -> Result<JsValue, JsValue> {
        let state = self.state.borrow();
        if let Some(document) = state.documents.get(&doc_id) {
            let commits: Vec<CommitOutput> = document
                .commits
                .iter()
                .map(|record| record.to_output())
                .collect();
            serde_wasm_bindgen::to_value(&commits).map_err(|e| JsValue::from_str(&e.to_string()))
        } else {
            Ok(JsValue::NULL)
        }
    }

    #[wasm_bindgen(js_name = addCommits)]
    pub fn add_commits(&self, args: JsValue) -> Result<JsValue, JsValue> {
        let parsed: AddCommitsArgs = serde_wasm_bindgen::from_value(args)?;
        let mut state = self.state.borrow_mut();
        let document = state
            .documents
            .get_mut(&parsed.doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;

        let mut any_new = false;
        for commit in parsed.commits {
            let record = parse_commit(commit)?;
            if document.append_commit(record) {
                any_new = true;
            }
        }

        let result = AddCommitsResult { success: true, new_commits: any_new };
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = waitUntilSynced)]
    pub fn wait_until_synced(&self, _peer_id: String) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::from_bool(true)) })
    }

    #[wasm_bindgen(js_name = createContactCard)]
    pub fn create_contact_card(&self) -> String {
        "00000000000000000000000000000000".to_string()
    }

    #[wasm_bindgen(js_name = stop)]
    pub fn stop(&self) {
        let mut state = self.state.borrow_mut();
        state.documents.clear();
    }

    #[wasm_bindgen(js_name = version)]
    pub fn version(&self) -> String {
        "subduction-wasm-0.1.0".to_string()
    }
}

#[derive(Serialize)]
struct AddCommitsResult {
    success: bool,
    #[serde(rename = "newCommits")]
    new_commits: bool,
}

#[wasm_bindgen]
pub struct MemorySigner;

#[wasm_bindgen]
impl MemorySigner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MemorySigner {
        MemorySigner
    }

    #[wasm_bindgen(getter, js_name = verifyingKey)]
    pub fn verifying_key(&self) -> Uint8Array {
        Uint8Array::new_with_length(32)
    }

    #[wasm_bindgen(getter, js_name = signingKey)]
    pub fn signing_key(&self) -> Uint8Array {
        Uint8Array::new_with_length(32)
    }

    #[wasm_bindgen(js_name = sign)]
    pub fn sign(&self, _message: Uint8Array) -> js_sys::Promise {
        future_to_promise(async { Ok(Uint8Array::new_with_length(64).into()) })
    }
}

#[wasm_bindgen]
pub struct MemoryStorageAdapter;

#[wasm_bindgen]
impl MemoryStorageAdapter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MemoryStorageAdapter {
        MemoryStorageAdapter
    }

    #[wasm_bindgen(js_name = load)]
    pub fn load(&self, _key: JsValue) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::UNDEFINED) })
    }

    #[wasm_bindgen(js_name = loadRange)]
    pub fn load_range(&self, _prefix: JsValue) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::from(js_sys::Map::new())) })
    }

    #[wasm_bindgen(js_name = save)]
    pub fn save(&self, _key: JsValue, _data: Uint8Array) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::UNDEFINED) })
    }

    #[wasm_bindgen(js_name = remove)]
    pub fn remove(&self, _key: JsValue) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::UNDEFINED) })
    }

    #[wasm_bindgen(js_name = listOneLevel)]
    pub fn list_one_level(&self, _prefix: JsValue) -> js_sys::Promise {
        future_to_promise(async { Ok(JsValue::from(js_sys::Array::new())) })
    }
}

#[wasm_bindgen]
pub fn parse_beelay_doc_id(val: String) -> String {
    val
}
