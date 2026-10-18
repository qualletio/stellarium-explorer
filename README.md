# stellarium-explorer
An desktop app explorer for writing and executing requests, and browsing Stellarium networks.

## Running locally

The app is built with [Tauri 2](https://tauri.app): a React + Vite frontend in `src/` and a Rust backend in `src-tauri/`.

### Prerequisites

- [Node.js](https://nodejs.org) (LTS) and [pnpm](https://pnpm.io)
- [Rust](https://rustup.rs) 1.85 or newer (the backend uses the 2024 edition)
- Tauri's platform dependencies — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) (on macOS this is the Xcode Command Line Tools: `xcode-select --install`)

### Install dependencies

```sh
pnpm install
```

### Start the app in development mode

```sh
pnpm tauri dev
```

This starts the Vite dev server on `http://localhost:1420` and opens the desktop window with hot reload. The first run compiles the Rust backend and takes a few minutes; later runs are much faster.

### Build a release bundle

```sh
pnpm tauri build
```

Installers and app bundles are written to `src-tauri/target/release/bundle/`.

Release builds also produce signed updater artifacts, so `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) must be set; see [Releasing](#releasing).

### Tests and checks

```sh
pnpm test    # frontend unit tests (Vitest)
pnpm check   # type-check, frontend tests, cargo test, and cargo clippy
```

## Releasing

The app checks GitHub Releases for updates shortly after launch and every 6 hours. When it finds one, it offers to download, install and restart. Update bundles are verified against the public key in `src-tauri/tauri.conf.json`.

### One-time setup

1. Generate the updater signing key:
   ```sh
   pnpm tauri signer generate -w ~/.tauri/stellarium-explorer.key
   ```
2. Put the printed public key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Add the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of the key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Back up the private key. Without it, installed copies can't be updated.

### Publishing a version

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Commit, tag `vX.Y.Z`, and push the tag. The **Release** workflow builds every platform and creates a draft release with `latest.json`.
3. Publish the draft. Installed apps pick up the update on their next check.
