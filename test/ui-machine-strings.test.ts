import assert from "node:assert/strict";
import { test } from "node:test";
import { strings } from "../src/ui/strings";

const machine = strings.settings.machine;
const queue = strings.queue;
const wait = strings.deskModules.standard.reasons.machine;

test("memory figures use the French decimal comma, in the machine card and the queue", () => {
  assert.equal(machine.reading({ ramFree: 8.98, ramTotal: 31.9, vram: machine.vram(9.12, 24) }), "Maintenant : 8,98 Go de mémoire vive libres sur 31,9, 9,12 Go de mémoire vidéo libres sur 24.");
  assert.equal(machine.margins(4, 1.5), "Marge gardée libre : 4 Go de mémoire vive, 1,5 Go de mémoire vidéo.");
  assert.equal(queue.machine({ ramFree: 8.98, vram: queue.vram(9.12) }), "Machine : 8,98 Go de mémoire vive libres, 9,12 Go de mémoire vidéo libres.");
});

test("the reasons built by the server print their figures with a comma too", () => {
  const reason = wait({ kind: "ram", needGb: 6.5, keepGb: 2, freeGb: 9.12, reservedGb: 0.5, leftGb: 0.62 });
  assert.match(reason, /il faut 6,5 Go/);
  assert.match(reason, /il en reste 0,62 \(9,12 libres, 0,5 réservés/);
  assert.doesNotMatch(reason, /\d\.\d/);
});

test("a missing measurement reads « aucune » rather than « non »", () => {
  assert.equal(machine.gb(null), "aucune");
  assert.equal(machine.gb(2.25), "2,25 Go");
});
