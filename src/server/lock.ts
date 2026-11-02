import fs from "node:fs";
import path from "node:path";

/** Local single-instance lock: a file holding the pid of the process that holds it. */
export type Lock = { release(): void };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the lock file, or returns null when a live process (this one
 * included) already holds it. A lock left by a dead process is taken over.
 */
export function acquireLock(file: string): Lock | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      const release = () => {
        try {
          if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
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
    if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || isAlive(pid))) return null;
    fs.rmSync(file, { force: true });
  }
  return null;
}
