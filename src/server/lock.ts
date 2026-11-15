import fs from "node:fs";
import path from "node:path";

/**
 * Local single-instance lock: a file holding the pid of the process that holds
 * it. The holder refreshes the file's modification time on a timer (a
 * heartbeat), and the lock only counts as held while its pid is alive AND the
 * file was refreshed recently. The pid alone is not enough: after an unclean
 * shutdown (power loss, fast startup, kill) the file keeps the old pid, and an
 * unrelated program may own that number after the next boot.
 */
export type Lock = { release(): void };

/** How often the holder refreshes the lock file. */
const HEARTBEAT_MS = 15_000;
/**
 * A lock not refreshed for this long is stale. Several heartbeats, so a busy
 * event loop or a slow disk that delays one or two refreshes never makes a live
 * holder look dead.
 */
const STALE_MS = 60_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the file was refreshed less than STALE_MS ago. A missing file is not fresh. */
function isFresh(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes the lock file, or returns null when a live process (this one
 * included) already holds it, that is when its pid is alive and the file was
 * refreshed within the last minute. A lock left by a dead process, or one
 * whose pid was reused after an unclean shutdown (no recent heartbeat), is
 * taken over. The holder keeps the lock fresh until `release()`.
 */
export function acquireLock(file: string): Lock | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      const holdsFile = () => fs.readFileSync(file, "utf8").trim() === String(process.pid);
      const heartbeat = setInterval(() => {
        try {
          if (holdsFile()) {
            const now = new Date();
            fs.utimesSync(file, now, now);
          }
        } catch {
          // File gone: nothing to refresh.
        }
      }, HEARTBEAT_MS);
      heartbeat.unref();
      const release = () => {
        clearInterval(heartbeat);
        try {
          if (holdsFile()) fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
      process.once("exit", release);
      return { release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || isAlive(pid)) && isFresh(file)) return null;
    fs.rmSync(file, { force: true });
  }
  return null;
}
