import assert from "node:assert/strict";
import { test } from "node:test";
import { isNextStartOf, parseNetstat, parsePm2List, parseSs } from "../scripts/deploy";

test("pm2 jlist: the apps with their pid and state, after a warning line", () => {
  const apps = parsePm2List(
    '[PM2] Spawning PM2 daemon\n[{"name":"myhq","pid":75412,"pm2_env":{"status":"online"}},{"name":"x","pid":0,"pm2_env":{"status":"stopped"}}]',
  );
  assert.deepEqual(apps, [
    { name: "myhq", pid: 75412, status: "online" },
    { name: "x", pid: 0, status: "stopped" },
  ]);
  assert.deepEqual(parsePm2List("[PM2] Spawning PM2 daemon\n[]"), []);
  assert.deepEqual(parsePm2List("no json"), []);
});

test("netstat and ss: the pid that listens on the port, not a client connected to it", () => {
  const netstat = [
    "  TCP    127.0.0.1:4242         0.0.0.0:0              LISTENING       75412",
    "  TCP    127.0.0.1:4343         0.0.0.0:0              ÉCOUTE          34140",
    "  TCP    127.0.0.1:4343         127.0.0.1:51662        ESTABLISHED     34140",
    "  TCP    127.0.0.1:51662        127.0.0.1:4343         ESTABLISHED     31304",
    "  TCP    [::]:4545              [::]:0                 LISTENING       99",
  ].join("\r\n");
  assert.equal(parseNetstat(netstat, 4242), 75412);
  assert.equal(parseNetstat(netstat, 4343), 34140);
  assert.equal(parseNetstat(netstat, 4545), 99);
  assert.equal(parseNetstat(netstat, 4444), null);
  const ss = 'LISTEN 0 511 127.0.0.1:4343 0.0.0.0:* users:(("next-server",pid=812,fd=19))\nLISTEN 0 4096 0.0.0.0:22 0.0.0.0:* ';
  assert.equal(parseSs(ss, 4343), 812);
  assert.equal(parseSs(ss, 22), null);
});

test("only the next start of this repository counts as a MyHQ orphan", () => {
  const root = "D:\\Documents\\Projets\\myhq";
  const own =
    '"C:\\Program Files\\nodejs\\node.exe" D:\\Documents\\Projets\\myhq\\node_modules\\next\\dist\\bin\\next start -p 4242 -H 127.0.0.1';
  assert.equal(isNextStartOf(own, root), true);
  assert.equal(isNextStartOf(own.replace("Projets\\myhq", "Projets\\other"), root), false, "another repository");
  assert.equal(isNextStartOf(own.replace(" start ", " dev "), root), false, "not next start");
  assert.equal(isNextStartOf("node server.js --port 4242", root), false);
  assert.equal(isNextStartOf(own.replace("myhq\\node_modules", "myhq-copy\\node_modules"), root), false, "a folder with the same prefix");
  assert.equal(isNextStartOf("/srv/myhq/node_modules/next/dist/bin/next start -p 1", "/srv/myhq"), true);
});
