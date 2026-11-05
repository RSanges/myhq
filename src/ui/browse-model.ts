import type { DirListing } from "./schemas";

// Pure parts of the room browser (« Parcourir » of the room form), kept out of
// the component so that they can be tested.

export type Crumb = { label: string; path: string };

/** The trail from the root to the folder listed: the root's name, then one crumb per folder, each with the path to ask for. */
export function breadcrumbs(listing: Pick<DirListing, "rootName" | "path">): Crumb[] {
  const crumbs: Crumb[] = [{ label: listing.rootName, path: "" }];
  let at = "";
  for (const segment of listing.path.split("/").filter((s) => s !== "")) {
    at = at === "" ? segment : `${at}/${segment}`;
    crumbs.push({ label: segment, path: at });
  }
  return crumbs;
}

/** The folders that look like projects first, the others after, each group in the order given (alphabetical). */
export function groupDirs(dirs: DirListing["dirs"]): { projects: DirListing["dirs"]; others: DirListing["dirs"] } {
  return { projects: dirs.filter((dir) => dir.project), others: dirs.filter((dir) => !dir.project) };
}

/** What « Choisir ce dossier » writes in the path field: the path `POST /api/onboarding` expects. */
export function chosenPath(listing: Pick<DirListing, "target">): string {
  return listing.target;
}
