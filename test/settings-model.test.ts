import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { buildSettingsView } from "../src/server/settings";
import {
  addressFromParams,
  filterRooms,
  isDirty,
  limitsErrors,
  limitsForm,
  limitsInput,
  parseDecimal,
  rebase,
  roomErrors,
  roomForm,
  roomInput,
  searchOf,
  tabAfterKey,
} from "../src/ui/settings-model";
import { makeHome } from "./helpers";

// The settings page as a model: the tab an address opens, the address of a
// tab, the arrows of the tab bar, and when a tab's form is dirty.

const params = (search: string) => new URLSearchParams(search);
const view = () => {
  const config = makeHome();
  return buildSettingsView(config, getDbAt(config.dbPath), {});
};

test("the address opens its tab, an unknown one opens « Général », a room or a deletion opens « Salles »", () => {
  assert.deepEqual(addressFromParams(params("")), { tab: "general", room: null, deleting: null });
  assert.deepEqual(addressFromParams(params("?onglet=limites")), { tab: "limites", room: null, deleting: null });
  assert.deepEqual(addressFromParams(params("?onglet=nope")), { tab: "general", room: null, deleting: null });
  assert.deepEqual(addressFromParams(params("?salle=demo")), { tab: "salles", room: "demo", deleting: null });
  assert.deepEqual(addressFromParams(params("?onglet=securite&supprimer=demo")), { tab: "salles", room: null, deleting: "demo" });
  // A name that cannot be a room is ignored.
  assert.deepEqual(addressFromParams(params("?salle=../x")), { tab: "general", room: null, deleting: null });
});

test("an address is written back the same way, the default tab left out", () => {
  assert.equal(searchOf({ tab: "general", room: null, deleting: null }), "");
  assert.equal(searchOf({ tab: "notifications", room: null, deleting: null }), "?onglet=notifications");
  assert.equal(searchOf({ tab: "salles", room: "demo", deleting: null }), "?onglet=salles&salle=demo");
  for (const search of ["?onglet=limites", "?onglet=salles&salle=demo", "?onglet=salles&supprimer=demo"]) {
    assert.equal(searchOf(addressFromParams(params(search))), search);
  }
});

test("the arrows move along the tabs and wrap around, Home and End go to the ends", () => {
  assert.equal(tabAfterKey("general", "ArrowRight"), "salles");
  assert.equal(tabAfterKey("general", "ArrowLeft"), "securite");
  assert.equal(tabAfterKey("securite", "ArrowRight"), "general");
  assert.equal(tabAfterKey("limites", "Home"), "general");
  assert.equal(tabAfterKey("limites", "End"), "securite");
  assert.equal(tabAfterKey("limites", "Enter"), null);
});

test("a tab is dirty only when its form differs from the saved settings", () => {
  const settings = view();
  const saved = limitsForm(settings);
  assert.equal(isDirty(limitsForm(settings), saved), false);
  assert.equal(isDirty({ ...saved, cap: "5" }, saved), true);
  assert.equal(isDirty({ ...saved, portier: !saved.portier }, saved), true);
  // Back to the saved value: clean again. The order of the keys does not count.
  assert.equal(isDirty({ ...saved, cap: "" }, saved), false);
  const reordered = Object.fromEntries(Object.entries(saved).reverse());
  assert.equal(isDirty(reordered, saved), false);

  const room = settings.rooms[0]!;
  const form = roomForm(room);
  assert.equal(isDirty(roomForm(room), form), false);
  assert.equal(isDirty({ ...form, label: "Démo" }, form), true);
  assert.equal(isDirty({ ...form, agents: { scout: { ...form.agents.scout!, budget: "2" } } }, form), true);
});

test("the limits form checks its numbers and sends null to go back to the environment", () => {
  const settings = view();
  const form = { ...limitsForm(settings), cap: "x", defaultBudget: "0", weeklyBudget: "12,5", timeout: "200" };
  assert.deepEqual(Object.keys(limitsErrors(form, settings)).sort(), ["cap", "defaultBudget", "timeout"]);
  assert.equal(parseDecimal("12,5"), 12.5);
  const ok = { ...limitsForm(settings), weeklyBudget: "12,5", timeout: "20", hardLimit: "60" };
  assert.deepEqual(limitsErrors(ok, settings), {});
  assert.deepEqual(limitsInput(ok), {
    scheduler: null,
    maxRunsPerDay: null,
    defaultMaxBudgetUsd: null,
    weeklyBudgetUsd: 12.5,
    runTimeoutMinutes: 20,
    runHardLimitMinutes: 60,
    portier: settings.portier.enabled,
    runSummaries: true,
  });
});

test("a room's panel checks its fields and saves that room alone", () => {
  const settings = view();
  const room = settings.rooms[0]!;
  const form = { ...roomForm(room), label: "  Démo client ", color: "#f37" };
  assert.deepEqual(roomErrors(form), { budgets: [] });
  assert.deepEqual(roomErrors({ ...form, color: "red", agents: { scout: { ...form.agents.scout!, budget: "-1" } } }), {
    color: true,
    budgets: ["scout"],
  });
  assert.deepEqual(roomInput(room, form), {
    rooms: [{ name: "demo", label: "Démo client", color: "#f37", agents: [{ id: "scout", model: "haiku", armed: false, maxBudgetUsd: null }] }],
  });
  assert.deepEqual(
    filterRooms([{ state: "active" as const }, { state: "paused" as const }], "paused"),
    [{ state: "paused" }],
  );
});

test("when the saved settings change under a form, untouched values follow and edited ones stay", () => {
  type Form = { label: string; color: string; agents: Record<string, { armed: boolean; budget: string }> };
  const previous: Form = { label: "", color: "", agents: { a: { armed: true, budget: "" }, b: { armed: true, budget: "" } } };
  const current: Form = { label: "Démo", color: "", agents: { a: { armed: true, budget: "2" }, b: { armed: true, budget: "" } } };
  // A pause disarmed both agents, and agent b left the room while c came in.
  const next: Form = { label: "", color: "", agents: { a: { armed: false, budget: "" }, c: { armed: false, budget: "" } } };
  assert.deepEqual(rebase(current, previous, next), {
    label: "Démo",
    color: "",
    agents: { a: { armed: false, budget: "2" }, c: { armed: false, budget: "" } },
  });
  assert.deepEqual(rebase(previous, previous, next), next);
});
