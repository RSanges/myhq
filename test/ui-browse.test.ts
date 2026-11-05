import assert from "node:assert/strict";
import { test } from "node:test";
import { breadcrumbs, chosenPath, groupDirs } from "../src/ui/browse-model";
import { dirListingSchema } from "../src/ui/schemas";

test("the trail starts at the root and has one clickable crumb per folder, with the path to ask for", () => {
  assert.deepEqual(breadcrumbs({ rootName: "projects", path: "" }), [{ label: "projects", path: "" }]);
  assert.deepEqual(breadcrumbs({ rootName: "projects", path: "a/b/c" }), [
    { label: "projects", path: "" },
    { label: "a", path: "a" },
    { label: "b", path: "a/b" },
    { label: "c", path: "a/b/c" },
  ]);
});

test("projects come first, the others after, each group keeping its order", () => {
  const dir = (name: string, project: boolean) => ({ name, path: name, project, room: null });
  const groups = groupDirs([dir("a", false), dir("b", true), dir("c", false), dir("d", true)]);
  assert.deepEqual(groups.projects.map((d) => d.name), ["b", "d"]);
  assert.deepEqual(groups.others.map((d) => d.name), ["a", "c"]);
});

test("choosing a folder fills the field with the path the server gave for onboarding, as is", () => {
  const listing = dirListingSchema.parse({
    rootName: "projects",
    path: "my-app",
    parent: "",
    target: "../my-app",
    project: true,
    room: null,
    dirs: [],
  });
  assert.equal(chosenPath(listing), "../my-app");
});
