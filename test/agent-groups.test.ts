import assert from "node:assert/strict";
import { test } from "node:test";
import { groupOf, placeAgents } from "../src/ui/agent-groups";
import type { AgentStatus } from "../src/ui/room-model";

const status = (kind: AgentStatus["kind"]): AgentStatus =>
  kind === "visiting" || kind === "talking" ? { kind, target: "x" } : ({ kind } as AgentStatus);

test("every status falls in one of the three groups", () => {
  const working = ["seated", "typing", "thinking", "visiting", "talking", "carrying", "dropping", "returning"] as const;
  for (const kind of working) assert.equal(groupOf(status(kind)), "working", kind);
  assert.equal(groupOf(status("blocked")), "waiting");
  assert.equal(groupOf(status("failed")), "waiting");
  assert.equal(groupOf(status("asleep")), "resting");
  assert.equal(groupOf(null), "resting");
});

test("the strip puts the agents at work first, then the ones that wait, then the ones asleep, keeping the order inside a group", () => {
  const agents: [string, AgentStatus["kind"]][] = [
    ["a", "asleep"],
    ["b", "typing"],
    ["c", "blocked"],
    ["d", "asleep"],
    ["e", "visiting"],
    ["f", "failed"],
    ["g", "thinking"],
  ];
  const placed = placeAgents(agents, ([, kind]) => status(kind));
  assert.deepEqual(
    placed.map((entry) => entry.item[0]),
    ["b", "e", "g", "c", "f", "a", "d"],
  );
  assert.deepEqual(
    placed.map((entry) => entry.label),
    ["working", null, null, "waiting", null, "resting", null],
  );
});

test("the groups are named only when there are several, and an empty group is skipped", () => {
  const only = placeAgents(["a", "b"], () => status("asleep"));
  assert.deepEqual(only.map((entry) => entry.label), [null, null]);
  const two = placeAgents(["a", "b"], (name) => status(name === "a" ? "asleep" : "typing"));
  assert.deepEqual(two.map((entry) => [entry.item, entry.label]), [["b", "working"], ["a", "resting"]]);
});

test("without any status yet the order is left alone and nothing is named", () => {
  const placed = placeAgents(["a", "b", "c"], () => null);
  assert.deepEqual(placed.map((entry) => entry.item), ["a", "b", "c"]);
  assert.ok(placed.every((entry) => entry.label === null));
});

test("an agent changing state moves between the groups on the next placement", () => {
  const state = new Map<string, AgentStatus["kind"]>([["a", "asleep"], ["b", "asleep"]]);
  const order = () => placeAgents(["a", "b"], (name) => status(state.get(name)!)).map((entry) => entry.item);
  assert.deepEqual(order(), ["a", "b"]);
  state.set("b", "typing");
  assert.deepEqual(order(), ["b", "a"]);
});
