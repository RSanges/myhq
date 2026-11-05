import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamAgent } from "../src/ui/model";
import { groupByRoom } from "../src/ui/recipient-groups";

const agent = (room: string, id: string, color: string | null): TeamAgent =>
  ({ id, name: id, room, key: `${room}/${id}`, color, state: "idle" }) as unknown as TeamAgent;

test("agents are grouped by room, rooms and agents in the order they come", () => {
  const groups = groupByRoom([
    agent("alpha", "a1", "#112233"),
    agent("beta", "b1", null),
    agent("alpha", "a2", "#112233"),
    agent("beta", "b2", null),
    agent("gamma", "g1", "#445566"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.room, group.color, group.agents.map((each) => each.id)]),
    [
      ["alpha", "#112233", ["a1", "a2"]],
      ["beta", null, ["b1", "b2"]],
      ["gamma", "#445566", ["g1"]],
    ],
  );
});

test("no agents, no groups", () => {
  assert.deepEqual(groupByRoom([]), []);
});
