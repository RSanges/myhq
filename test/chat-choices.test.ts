import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChoices, MAX_CHOICES, selectionMessage, textWithoutChoices } from "../src/assistant/choices";
import { corePreamble, lastExchangeText } from "../src/assistant/preamble";
import { getDbAt, type Db } from "../src/server/db";
import { selectionKeyboard, parseSelectionData } from "../src/assistant/selection-buttons";
import { makeHome } from "./helpers";

// Two generic chat features: the `lastExchange` preamble field, and the
// selection lists (a task list in a reply becomes choices to tick).

// --- The lastExchange preamble field ------------------------------------------------

const ZONE = "Europe/Paris";
/** 14:05 in Paris (winter time). */
const NOW = new Date("2026-11-03T13:05:00Z");

function say(db: Db, at: string, options: { target?: string; role?: string } = {}) {
  db.prepare("INSERT INTO chat_messages (role, kind, channel, target, text, created_at) VALUES (?, NULL, 'desk', ?, 'x', ?)").run(
    options.role ?? "user",
    options.target ?? null,
    at,
  );
}

test("lastExchange words the time since the last message to the chat, in HQ_TIMEZONE", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const last = () => lastExchangeText(db, ZONE, NOW);
  assert.equal(last(), "Dernier échange : premier échange aujourd'hui.");
  say(db, "2026-10-30T21:40:00Z");
  say(db, "2026-11-02T21:40:00Z");
  assert.equal(last(), "Dernier échange : hier à 22 h 40.");
  say(db, "2026-11-03T08:00:00Z", { role: "assistant" });
  assert.equal(last(), "Dernier échange : hier à 22 h 40.", "the latest message of the user counts, not the replies");
  db.prepare("DELETE FROM chat_messages").run();
  say(db, "2026-10-30T21:40:00Z");
  assert.equal(last(), "Dernier échange : vendredi 30 octobre à 22 h 40.");
  say(db, "2026-11-03T09:00:00Z");
  assert.equal(last(), "Dernier échange : il y a 4 h 05.");
  say(db, "2026-11-03T10:05:00Z");
  assert.equal(last(), "Dernier échange : il y a 3 h.");
  say(db, "2026-11-03T12:53:00Z");
  assert.equal(last(), "Dernier échange : il y a 12 min.");
  say(db, "2026-11-03T13:04:40Z");
  assert.equal(last(), "Dernier échange : à l'instant.");
});

test("lastExchange ignores the tasks given to an agent, and uses the local day for yesterday", () => {
  const db = getDbAt(makeHome().dbPath);
  say(db, "2026-11-03T13:00:00Z", { target: JSON.stringify({ room: "demo", agent: "scout" }) });
  assert.equal(lastExchangeText(db, ZONE, NOW), "Dernier échange : premier échange aujourd'hui.");
  // 23:30 UTC on the 2nd is 00:30 on the 3rd in Paris: today, not yesterday.
  say(db, "2026-11-02T23:30:00Z");
  assert.equal(lastExchangeText(db, ZONE, NOW), "Dernier échange : il y a 13 h 35.");
});

test("the core's lines put lastExchange after the date, and leave it out when it is not asked for", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  say(db, "2026-11-03T12:53:00Z");
  const lines = corePreamble(db, config, ["datetime", "lastExchange", "runs"], NOW);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "Dernier échange : il y a 12 min.");
  assert.equal(corePreamble(db, config, ["datetime", "runs"], NOW).length, 2);
});

// --- Task-list detection ------------------------------------------------------------

test("a task list becomes choices, with the id of each label when it has one", () => {
  const reply = [
    "Voici ce qui attend :",
    "",
    "- [ ] 1. Mairie de Paris : recours FPS",
    "- [ ] 2) Relance du notaire",
    "- [ ] A3. Dossier assurance",
    "",
    "Dis-moi lesquels traiter.",
  ].join("\n");
  assert.deepEqual(extractChoices(reply), [
    { id: "1", label: "1. Mairie de Paris : recours FPS" },
    { id: "2", label: "2) Relance du notaire" },
    { id: "A3", label: "A3. Dossier assurance" },
  ]);
  assert.equal(textWithoutChoices(reply), "Voici ce qui attend :\n\nDis-moi lesquels traiter.");
});

test("labels without an id are kept whole; a leading word or a year is not an id", () => {
  const choices = extractChoices("- [ ] Appeler le notaire\n* [ ] Dr. Martin, rendez-vous\n+ [ ] 2024 était calme")!;
  assert.deepEqual(
    choices.map((choice) => choice.id),
    [null, null, null],
  );
  assert.equal(
    selectionMessage(choices, new Set([0, 2])),
    "Sélection : Appeler le notaire, 2024 était calme",
    "the full labels when there is no id",
  );
});

test("the selection message lists the ids of the ticked items, in the order of the list", () => {
  const choices = extractChoices("- [ ] 1. a\n- [ ] 2. b\n- [ ] 3. c\n- [ ] 4. d\n- [ ] 5. e")!;
  assert.equal(selectionMessage(choices, new Set([4, 0, 2])), "Sélection : 1, 3, 5");
});

test("a task list of at most 12 items is a selection, a longer one stays plain", () => {
  const list = (count: number) => Array.from({ length: count }, (_, i) => `- [ ] ${i + 1}. Item ${i + 1}`).join("\n");
  assert.equal(MAX_CHOICES, 12);
  assert.equal(extractChoices(list(12))!.length, 12);
  assert.equal(extractChoices(list(13)), null);
  assert.equal(extractChoices("Rien à choisir ici.\n- une puce\n- [x] déjà fait"), null, "no unchecked task, no choice");
  assert.equal(extractChoices(""), null);
});

// --- Telegram keyboard data ---------------------------------------------------------

test("the keyboard has one toggle per item (☐ or ☑, label cut at 40), then validate and cancel", () => {
  const long = "1. " + "très long libellé ".repeat(5);
  const choices = extractChoices(`- [ ] 1. Court\n- [ ] ${long}`)!;
  const keyboard = selectionKeyboard(choices, new Set([1]));
  const rows = keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
  assert.equal(rows[0]![0], "☐ 1. Court");
  assert.ok(rows[1]![0]!.startsWith("☑ 1. très long libellé"));
  assert.ok(rows[1]![0]!.length <= 2 + 40);
  assert.ok(rows[1]![0]!.endsWith("..."));
  assert.deepEqual(rows[2], ["Valider la sélection", "Annuler"]);
  assert.deepEqual(
    keyboard.inline_keyboard.flat().map((button) => button.callback_data),
    ["hq:s:0", "hq:s:1", "hq:s:ok", "hq:s:no"],
  );
  assert.deepEqual(parseSelectionData("hq:s:3"), { action: "toggle", index: 3 });
  assert.deepEqual(parseSelectionData("hq:s:ok"), { action: "send" });
  assert.deepEqual(parseSelectionData("hq:s:no"), { action: "cancel" });
  assert.equal(parseSelectionData("hq:a:3"), null);
});
