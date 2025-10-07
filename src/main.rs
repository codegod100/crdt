use keyhive_core::{
    crypto::signer::memory::MemorySigner,
    keyhive::Keyhive,
    listener::no_listener::NoListener,
    store::ciphertext::memory::MemoryCiphertextStore,
};
use nonempty::nonempty;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Generate a signer
    let signer = MemorySigner::generate(&mut rand::thread_rng());

    // Create a memory store for ciphertext
    let store: MemoryCiphertextStore<[u8; 32], Vec<u8>> = MemoryCiphertextStore::new();

    // Create a keyhive instance
    let mut keyhive = Keyhive::generate(signer, store, NoListener, rand::thread_rng()).await?;

    // Content to encrypt
    let content = b"hello world".to_vec();
    let content_hash = blake3::hash(&content);

    // Generate a document
    let doc = keyhive
        .generate_doc(vec![], nonempty![content_hash.into()])
        .await?;

    // Encrypt the content
    let encrypted = keyhive
        .try_encrypt_content(doc.clone(), &content_hash.into(), &vec![], &content)
        .await?;

    // Decrypt the content
    let decrypted = keyhive.try_decrypt_content(doc, encrypted.encrypted_content())?;

    // Check if it matches
    assert_eq!(decrypted, content);
    println!("Encryption and decryption successful: {:?}", String::from_utf8(decrypted)?);

    Ok(())
}
