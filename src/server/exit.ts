/**
 * The last steps of a stop of the app: close the HTTP servers, then end the
 * process for sure. No dependency on the rest of the app, so that a test can
 * run it in a child process.
 */
import http from "node:http";
import net from "node:net";

/**
 * Stops the HTTP servers that listen in this process (the one of `next start`
 * included, which MyHQ cannot reach otherwise): the port is freed and the
 * open connections (event streams) are cut. Resolves once they are closed, or
 * after `timeoutMs`. Returns how many servers were closed.
 */
export async function closeServers(timeoutMs = 2_000): Promise<number> {
  // `_getActiveHandles` is not documented, but it is the only way to reach a server that was
  // started by someone else; without it nothing is closed and the exit below still frees the port.
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  const servers = handles.filter((handle): handle is net.Server => handle instanceof net.Server && handle.listening);
  const closed = servers.map(
    (server) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (server instanceof http.Server) server.closeAllConnections();
      }),
  );
  await Promise.race([Promise.all(closed), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  return servers.length;
}

/**
 * Ends the process now. `process.exit` is not used on its own: Node waits for
 * the threads of its pool before it really exits, so one blocked call (a name
 * lookup while the network is down, a stalled disk) keeps a process that
 * "exited" alive and holding its port. The `exit` listeners (run recovery,
 * lock release) are run here, then the process is killed outright, which waits
 * for nothing. `process.exit` stays as the fallback if the kill is refused.
 */
export function exitProcess(code: number): void {
  try {
    process.emit("exit", code);
  } catch {
    // A failing listener must not keep the process alive.
  }
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    // Not allowed to kill itself: the plain exit.
  }
  process.exit(code);
}
