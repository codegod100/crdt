use beelay_core::{
    contact_card::ContactCard,
    io::{IoAction, IoResult},
    keyhive::{KeyhiveEntityId, MemberAccess},
    Config, Event, PeerId, StreamDirection, UnixTimestampMillis,
};
use ed25519_dalek::SigningKey;
use ed25519_dalek::ed25519::signature::SignerMut;
use keyhive_core::{
    crypto::signer::memory::MemorySigner,
    keyhive::Keyhive,
    listener::no_listener::NoListener,
    store::ciphertext::memory::MemoryCiphertextStore,
};
use nonempty::nonempty;
use std::collections::{BTreeMap, HashMap, VecDeque};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // First, demonstrate Keyhive encryption/decryption
    println!("=== Keyhive Example ===");
    let signer = MemorySigner::generate(&mut rand::thread_rng());
    let store: MemoryCiphertextStore<[u8; 32], Vec<u8>> = MemoryCiphertextStore::new();
    let mut keyhive = Keyhive::generate(signer.clone(), store, NoListener, rand::thread_rng()).await?;
    let content = b"hello world".to_vec();
    let content_hash = blake3::hash(&content);
    let doc = keyhive
        .generate_doc(vec![], nonempty![content_hash.into()])
        .await?;
    let encrypted = keyhive
        .try_encrypt_content(doc.clone(), &content_hash.into(), &vec![], &content)
        .await?;
    let decrypted = keyhive.try_decrypt_content(doc, encrypted.encrypted_content())?;
    assert_eq!(decrypted, content);
    println!("Encryption and decryption successful: {:?}", String::from_utf8(decrypted)?);

    // Now, demonstrate Beelay data transport using test-inspired network simulation
    println!("\n=== Beelay Data Transport Example ===");
    sync_example().await?;

    Ok(())
}

async fn sync_example() -> Result<(), Box<dyn std::error::Error>> {
    let mut network = Network::new();
    let alice = network.create_peer("alice").build();
    let bob = network.create_peer("bob").build();

    // Get Bob's contact card
    let bob_contact = network.beelay(&bob).contact_card().unwrap();

    // Create a document on Alice, shared with Bob
    let (doc_id, initial_commit) = network.beelay(&alice).create_doc(vec![bob_contact.into()]).unwrap();
    println!("Alice created document with initial commit: {:?}", initial_commit.hash());

    // Add a commit with data
    let commit1 = beelay_core::Commit::new(
        vec![initial_commit.hash()],
        b"synced data from Alice".to_vec(),
        beelay_core::CommitHash::from(blake3::hash(b"synced data from Alice").as_bytes()),
    );
    network.beelay(&alice).add_commits(doc_id, vec![commit1.clone()]).unwrap();
    println!("Alice added commit with data: {:?}", String::from_utf8(commit1.contents().to_vec()));

    // Connect Alice and Bob
    let _connected = network.connect_stream(&alice, &bob);

    // Run until synced
    network.run_until_quiescent();

    // Check if Bob has the document
    let commits = network.beelay(&bob).load_doc(doc_id).unwrap_or_default();
    println!("Bob received {} commits", commits.len());
    for commit in commits {
        if let beelay_core::CommitOrBundle::Commit(c) = commit {
            println!("Commit content: {:?}", String::from_utf8(c.contents().to_vec()));
        }
    }

    Ok(())
}

// Network simulation adapted from beelay-core/tests/network/mod.rs

pub struct BeelayHandle<'a> {
    pub network: &'a mut Network,
    pub peer_id: PeerId,
}

impl BeelayHandle<'_> {
    pub fn create_doc(
        &mut self,
        other_owners: Vec<beelay_core::keyhive::KeyhiveEntityId>,
    ) -> Result<(beelay_core::DocumentId, beelay_core::Commit), beelay_core::error::Create> {
        let content = b"initial content".to_vec();
        self.create_doc_with_contents(content, other_owners)
    }

    pub fn create_doc_with_contents(
        &mut self,
        content: Vec<u8>,
        other_owners: Vec<beelay_core::keyhive::KeyhiveEntityId>,
    ) -> Result<(beelay_core::DocumentId, beelay_core::Commit), beelay_core::error::Create> {
        let hash = beelay_core::CommitHash::from(blake3::hash(&content).as_bytes());
        let initial_commit = beelay_core::Commit::new(vec![], content, hash);
        let (command, event) = Event::create_doc(initial_commit.clone(), other_owners);
        self.network.beelays.get_mut(&self.peer_id).unwrap().inbox.push_back(event);
        self.network.beelays.get_mut(&self.peer_id).unwrap().starting_commands.insert(command, ());
        self.network.run_until_quiescent();

        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        match beelay.completed_commands.remove(&command) {
            Some(Ok(beelay_core::CommandResult::CreateDoc(doc_id))) => {
                let doc_id = doc_id?;
                Ok((doc_id, initial_commit))
            }
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }

    pub fn add_commits(
        &mut self,
        doc_id: beelay_core::DocumentId,
        commits: Vec<beelay_core::Commit>,
    ) -> Result<Vec<beelay_core::BundleSpec>, beelay_core::error::AddCommits> {
        let (command, event) = Event::add_commits(doc_id, commits);
        self.network.beelays.get_mut(&self.peer_id).unwrap().inbox.push_back(event);
        self.network.beelays.get_mut(&self.peer_id).unwrap().starting_commands.insert(command, ());
        self.network.run_until_quiescent();
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        match beelay.completed_commands.remove(&command) {
            Some(Ok(beelay_core::CommandResult::AddCommits(new_bundles_needed))) => {
                new_bundles_needed
            }
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }

    pub fn load_doc(&mut self, doc_id: beelay_core::DocumentId) -> Option<Vec<beelay_core::CommitOrBundle>> {
        let (command, event) = Event::load_doc(doc_id);
        self.network.beelays.get_mut(&self.peer_id).unwrap().inbox.push_back(event);
        self.network.beelays.get_mut(&self.peer_id).unwrap().starting_commands.insert(command, ());
        self.network.run_until_quiescent();
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        match beelay.completed_commands.remove(&command) {
            Some(Ok(beelay_core::CommandResult::LoadDoc(commits))) => commits,
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }

    pub fn contact_card(&mut self) -> Result<ContactCard, beelay_core::error::CreateContactCard> {
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        let (command_id, event) = beelay_core::Event::create_contact_card();
        beelay.inbox.push_back(event);
        self.network.run_until_quiescent();
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        match beelay.completed_commands.remove(&command_id) {
            Some(Ok(beelay_core::CommandResult::Keyhive(
                beelay_core::keyhive::KeyhiveCommandResult::CreateContactCard(r),
            ))) => r,
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }

    pub fn add_member_to_doc(
        &mut self,
        doc: beelay_core::DocumentId,
        member: KeyhiveEntityId,
        access: MemberAccess,
    ) {
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        let (command_id, event) = beelay_core::Event::add_member_to_doc(doc, member, access);
        beelay.inbox.push_back(event);
        self.network.run_until_quiescent();
        let beelay = self.network.beelays.get_mut(&self.peer_id).unwrap();
        match beelay.completed_commands.remove(&command_id) {
            Some(Ok(beelay_core::CommandResult::Keyhive(
                beelay_core::keyhive::KeyhiveCommandResult::AddMemberToDoc,
            ))) => (),
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }
}

pub struct Network {
    beelays: HashMap<PeerId, BeelayWrapper>,
}

impl Network {
    pub fn new() -> Self {
        Self {
            beelays: HashMap::new(),
        }
    }

    pub fn beelay(&mut self, peer: &PeerId) -> BeelayHandle<'_> {
        assert!(self.beelays.contains_key(peer));
        BeelayHandle {
            network: self,
            peer_id: *peer,
        }
    }

    pub fn create_peer(&mut self, nickname: &'static str) -> PeerBuilder<'_> {
        PeerBuilder {
            network: self,
            nickname,
            signing_key: SigningKey::generate(&mut rand::thread_rng()),
        }
    }

    pub fn load_peer(
        &mut self,
        nickname: &str,
        config: Config<rand::rngs::ThreadRng>,
        mut signing_key: SigningKey,
    ) -> PeerId {
        let _peer_id = PeerId::from(signing_key.verifying_key());
        let mut storage = BTreeMap::new();
        let mut step = beelay_core::Beelay::load(config, UnixTimestampMillis::now());
        let mut completed_tasks = Vec::new();
        let beelay = loop {
            match step {
                beelay_core::loading::Step::Loading(loading, io_tasks) => {
                    for task in io_tasks {
                        let result = handle_task(&mut storage, &mut signing_key, task);
                        completed_tasks.push(result);
                    }
                    if let Some(task_result) = completed_tasks.pop() {
                        step = loading.handle_io_complete(UnixTimestampMillis::now(), task_result);
                    } else {
                        panic!("no tasks completed but still loading");
                    }
                }
                beelay_core::loading::Step::Loaded(beelay, io_tasks) => {
                    for task in io_tasks {
                        let result = handle_task(&mut storage, &mut signing_key, task);
                        completed_tasks.push(result);
                    }
                    break beelay;
                }
            }
        };

        let peer_id = beelay.peer_id();
        let beelay_wrapper = BeelayWrapper::new(signing_key, nickname, beelay);
        self.beelays.insert(peer_id, beelay_wrapper);
        self.run_until_quiescent();
        peer_id
    }

    pub fn connect_stream(&mut self, left: &PeerId, right: &PeerId) -> ConnectedPair {
        let left_stream_id = {
            let beelay = self.beelays.get_mut(left).unwrap();
            beelay.create_stream(
                right,
                StreamDirection::Connecting {
                    remote_audience: beelay_core::Audience::peer(right),
                },
            )
        };
        let right_stream_id = {
            let beelay = self.beelays.get_mut(right).unwrap();
            beelay.create_stream(
                left,
                StreamDirection::Accepting {
                    receive_audience: None,
                },
            )
        };
        self.run_until_quiescent();
        ConnectedPair {
            left_to_right: left_stream_id,
            right_to_left: right_stream_id,
        }
    }

    pub fn run_until_quiescent(&mut self) {
        loop {
            let mut messages = Vec::new();

            for (source_id, beelay) in self.beelays.iter_mut() {
                beelay.handle_events();
                if !beelay.outbox.is_empty() {
                    messages.push((*source_id, std::mem::take(&mut beelay.outbox)));
                }
            }
            if messages.is_empty() {
                break;
            }
            for (sender, outbound) in messages {
                for msg in outbound {
                    match msg {
                        Message::Request {
                            target,
                            senders_req_id,
                            request,
                        } => {
                            let target_beelay = self.beelays.get_mut(&target).unwrap();
                            let signed_message = beelay_core::SignedMessage::decode(&request).unwrap();
                            let (command_id, event) = Event::handle_request(signed_message, None);
                            target_beelay.inbox.push_back(event);
                            target_beelay.handling_requests.insert(command_id, (senders_req_id, sender));
                        }
                        Message::Response {
                            target,
                            id,
                            response,
                        } => {
                            let target = self.beelays.get_mut(&target).unwrap();
                            let response = beelay_core::EndpointResponse::decode(&response).unwrap();
                            let (_command_id, event) = Event::handle_response(id, response);
                            target.inbox.push_back(event);
                        }
                        Message::Stream { target, msg } => {
                            let target_beelay = self.beelays.get_mut(&target).unwrap();
                            let incoming_stream_id = target_beelay
                                .streams
                                .iter()
                                .find_map(
                                    |(stream, StreamState { remote_peer, .. })| {
                                        if *remote_peer == sender {
                                            Some(stream)
                                        } else {
                                            None
                                        }
                                    },
                                )
                                .unwrap();
                            let event = Event::handle_message(*incoming_stream_id, msg);
                            target_beelay.inbox.push_back(event);
                        }
                    }
                }
            }
        }
    }
}

enum Message {
    Request {
        target: PeerId,
        senders_req_id: beelay_core::OutboundRequestId,
        request: Vec<u8>,
    },
    Response {
        target: PeerId,
        id: beelay_core::OutboundRequestId,
        response: Vec<u8>,
    },
    Stream {
        target: PeerId,
        msg: Vec<u8>,
    },
}

pub struct BeelayWrapper {
    _nickname: String,
    signing_key: SigningKey,
    storage: BTreeMap<beelay_core::StorageKey, Vec<u8>>,
    core: beelay_core::Beelay<rand::rngs::ThreadRng>,
    outbox: Vec<Message>,
    inbox: VecDeque<Event>,
    completed_commands: HashMap<beelay_core::CommandId, Result<beelay_core::CommandResult, beelay_core::error::Stopping>>,
    handling_requests: HashMap<beelay_core::CommandId, (beelay_core::OutboundRequestId, PeerId)>,
    endpoints: HashMap<beelay_core::EndpointId, PeerId>,
    streams: HashMap<beelay_core::StreamId, StreamState>,
    starting_streams: HashMap<beelay_core::CommandId, StreamState>,
    starting_commands: HashMap<beelay_core::CommandId, ()>,
    now: UnixTimestampMillis,
}

impl BeelayWrapper {
    fn new(signing_key: SigningKey, nickname: &str, core: beelay_core::Beelay<rand::rngs::ThreadRng>) -> Self {
        Self {
            _nickname: nickname.to_string(),
            signing_key,
            storage: BTreeMap::new(),
            core,
            outbox: Vec::new(),
            inbox: VecDeque::new(),
            completed_commands: HashMap::new(),
            handling_requests: HashMap::new(),
            endpoints: HashMap::new(),
            streams: HashMap::new(),
            starting_streams: HashMap::new(),
            starting_commands: HashMap::new(),
            now: UnixTimestampMillis::now(),
        }
    }

    pub fn create_stream(
        &mut self,
        target: &PeerId,
        direction: StreamDirection,
    ) -> beelay_core::StreamId {
        let (command, event) = Event::create_stream(direction);
        self.starting_streams.insert(
            command,
            StreamState {
                remote_peer: *target,
            },
        );
        self.inbox.push_back(event);
        self.handle_events();
        match self.completed_commands.remove(&command) {
            Some(Ok(beelay_core::CommandResult::CreateStream(stream_id))) => stream_id,
            Some(other) => panic!("unexpected command result: {:?}", other),
            None => panic!("no command result"),
        }
    }

    pub fn handle_events(&mut self) {
        while let Some(event) = self.inbox.pop_front() {
            self.now += std::time::Duration::from_millis(10);
            let results = self.core.handle_event(self.now, event).unwrap();
            for task in results.new_tasks.into_iter() {
                let event = self.handle_task(task);
                self.inbox.push_back(event);
            }
            for (command, result) in results.completed_commands.into_iter() {
                if let Ok(beelay_core::CommandResult::CreateStream(stream_id)) = result {
                    let target = self.starting_streams.remove(&command).expect("should be a starting stream");
                    self.streams.insert(stream_id, target);
                }
                if let Ok(beelay_core::CommandResult::HandleRequest(response)) = &result {
                    let Ok(response) = response else { continue };
                    if let Some((sender_req_id, sender)) = self.handling_requests.remove(&command) {
                        self.outbox.push(Message::Response {
                            target: sender,
                            id: sender_req_id,
                            response: response.encode(),
                        });
                    }
                }
                self.completed_commands.insert(command, result);
            }
            for (target, msgs) in results.new_requests {
                let peer_id = self.endpoints.get(&target).expect("endpoint doesn't exist");
                for msg in msgs {
                    self.outbox.push(Message::Request {
                        target: *peer_id,
                        senders_req_id: msg.id,
                        request: msg.request.encode(),
                    })
                }
            }
            for (id, events) in results.new_stream_events {
                for event in events {
                    let StreamState { remote_peer: target, .. } = self.streams.get(&id).unwrap();
                    match event {
                        beelay_core::StreamEvent::Send(msg) => self.outbox.push(Message::Stream {
                            target: *target,
                            msg,
                        }),
                        _ => {}
                    }
                }
            }
        }
    }

    pub fn handle_task(&mut self, task: beelay_core::io::IoTask) -> Event {
        let result = handle_task(&mut self.storage, &mut self.signing_key, task);
        Event::io_complete(result)
    }
}

fn handle_task(
    storage: &mut BTreeMap<beelay_core::StorageKey, Vec<u8>>,
    signing_key: &mut SigningKey,
    task: beelay_core::io::IoTask,
) -> IoResult {
    let id = task.id();
    match task.take_action() {
        IoAction::Load { key } => {
            let data = storage.get(&key).cloned();
            IoResult::load(id, data)
        }
        IoAction::Put { key, data } => {
            storage.insert(key, data);
            IoResult::put(id)
        }
        IoAction::Delete { key } => {
            storage.remove(&key);
            IoResult::delete(id)
        }
        IoAction::LoadRange { prefix } => {
            let results = storage
                .iter()
                .filter_map(|(k, v)| {
                    if prefix.is_prefix_of(k) {
                        Some((k.clone(), v.clone()))
                    } else {
                        None
                    }
                })
                .collect();
            IoResult::load_range(id, results)
        }
        IoAction::ListOneLevel { prefix } => {
            let results = storage
                .keys()
                .filter_map(|k| k.onelevel_deeper(&prefix))
                .collect();
            IoResult::list_one_level(id, results)
        }
        IoAction::Sign { payload } => {
            let signature = signing_key.try_sign(&payload).unwrap();
            IoResult::sign(id, signature)
        }
    }
}

pub struct ConnectedPair {
    pub left_to_right: beelay_core::StreamId,
    pub right_to_left: beelay_core::StreamId,
}

pub struct StreamState {
    remote_peer: PeerId,
}

pub struct PeerBuilder<'a> {
    network: &'a mut Network,
    nickname: &'static str,
    signing_key: SigningKey,
}

impl PeerBuilder<'_> {
    pub fn build(self) -> PeerId {
        let config = Config::new(rand::thread_rng(), self.signing_key.verifying_key());
        self.network.load_peer(self.nickname, config, self.signing_key)
    }
}
