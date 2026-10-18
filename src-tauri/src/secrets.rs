//! Node API keys live in the OS keychain, keyed by the id of the scope that set them.

use uuid::Uuid;

use crate::error::AppResult;

const SERVICE: &str = "sh.stellarium.explorer";

pub trait SecretStore: Send + Sync {
    fn get(&self, scope: Uuid) -> AppResult<Option<String>>;
    fn set(&self, scope: Uuid, secret: &str) -> AppResult<()>;
    fn delete(&self, scope: Uuid) -> AppResult<()>;
}

pub struct Keychain;

impl Keychain {
    fn entry(scope: Uuid) -> AppResult<keyring::Entry> {
        Ok(keyring::Entry::new(SERVICE, &format!("node-key:{scope}"))?)
    }
}

impl SecretStore for Keychain {
    fn get(&self, scope: Uuid) -> AppResult<Option<String>> {
        match Self::entry(scope)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, scope: Uuid, secret: &str) -> AppResult<()> {
        Ok(Self::entry(scope)?.set_password(secret)?)
    }

    fn delete(&self, scope: Uuid) -> AppResult<()> {
        match Self::entry(scope)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// An in-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<Uuid, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, scope: Uuid) -> AppResult<Option<String>> {
        Ok(self.0.lock().unwrap().get(&scope).cloned())
    }

    fn set(&self, scope: Uuid, secret: &str) -> AppResult<()> {
        self.0.lock().unwrap().insert(scope, secret.to_string());
        Ok(())
    }

    fn delete(&self, scope: Uuid) -> AppResult<()> {
        self.0.lock().unwrap().remove(&scope);
        Ok(())
    }
}
