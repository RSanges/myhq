import assert from "node:assert/strict";
import { test } from "node:test";
import { agentKey, initialModel, reducer, selectAgents } from "../src/ui/model";
import { chipStyle, normalizeRoomColor } from "../src/ui/room-color";
import { stateSchema } from "../src/ui/schemas";

test("a hex colour is normalized to lowercase #rrggbb", () => {
  assert.equal(normalizeRoomColor("#FF3D7F"), "#ff3d7f");
  assert.equal(normalizeRoomColor(" #f37 "), "#ff3377");
});

test("anything that is not a hex colour is refused, so that nothing odd reaches a style", () => {
  for (const value of [null, undefined, "", "pink", "ff3d7f", "#ff3d7", "#ff3d7f; color: red", "url(x)", "var(--accent)"]) {
    assert.equal(normalizeRoomColor(value), null, String(value));
    assert.equal(chipStyle(value), null, String(value));
  }
});

test("the chip style hands the colour over as --room-color, and a room without colour has none", () => {
  assert.deepEqual(chipStyle("#FF3D7F"), { "--room-color": "#ff3d7f" });
  assert.equal(chipStyle(null), null);
});

test("the state carries each room's colour to its agents (null by default)", () => {
  const agent = { id: "a", name: "A", model: "haiku", role: "r.md", lastRun: null };
  const state = stateSchema.parse({
    cursor: 1,
    rooms: [
      { name: "planygo", color: "#ff3d7f", agents: [agent] },
      { name: "plain", agents: [agent] },
    ],
    invalidRooms: [],
    approvals: { pending: [], unseen: [], history: [] },
    recent: { events: [], messages: [] },
  });
  const agents = selectAgents(reducer(initialModel, { type: "state", state }));
  assert.equal(agents.find((each) => each.key === agentKey("planygo", "a"))?.color, "#ff3d7f");
  assert.equal(agents.find((each) => each.key === agentKey("plain", "a"))?.color, null);
});
