import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** The newest release, if it's newer than this build. Network failures count as "none": being offline isn't news. */
export async function checkForUpdate(): Promise<Update | null> {
  // Dev builds aren't signed release bundles; there's nothing to update.
  if (import.meta.env.DEV) return null;
  try {
    return await check();
  } catch (error) {
    console.warn("Update check failed:", error);
    return null;
  }
}

/** Downloads, verifies and installs `update`, reporting progress as 0–1 (null while the size is unknown), then restarts. */
export async function installAndRelaunch(update: Update, onProgress: (fraction: number | null) => void): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(received / total, 1) : null);
    }
  });
  await relaunch();
}
