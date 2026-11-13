import type { SettingsView } from "@/server/settings-schema";

// The settings page as a model, pure: its tabs and their address, and for each
// tab the form it edits, built from the settings and compared with them (a
// tab is dirty when its form differs from what is saved), and turned into the
// body of its save. The components hold the form in state; nothing here
// touches the DOM.

export const SETTINGS_TABS = ["general", "salles", "limites", "notifications", "securite"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The query parameters of the page: `onglet`, plus `salle` (a room's panel) and `supprimer` (its deletion). */
export const TAB_PARAM = "onglet";
export const ROOM_PARAM = "salle";
export const DELETE_PARAM = "supprimer";

export type SettingsAddress = { tab: SettingsTab; room: string | null; deleting: string | null };

const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * The tab, room panel and deletion an address opens. An unknown tab opens
 * « Général »; a room (or a deletion) opens « Salles » whatever `onglet` says.
 */
export function addressFromParams(params: { get(name: string): string | null }): SettingsAddress {
  const room = params.get(ROOM_PARAM);
  const deleting = params.get(DELETE_PARAM);
  const okRoom = room !== null && ROOM_NAME.test(room) ? room : null;
  const okDeleting = deleting !== null && ROOM_NAME.test(deleting) ? deleting : null;
  const tab = params.get(TAB_PARAM);
  const known = SETTINGS_TABS.find((each) => each === tab) ?? "general";
  return { tab: okRoom || okDeleting ? "salles" : known, room: okRoom, deleting: okDeleting };
}

/** The search string of an address (`?onglet=...`), the default tab left out. */
export function searchOf(address: SettingsAddress): string {
  const params = new URLSearchParams();
  if (address.tab !== "general") params.set(TAB_PARAM, address.tab);
  if (address.room) params.set(ROOM_PARAM, address.room);
  if (address.deleting) params.set(DELETE_PARAM, address.deleting);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The tab one arrow key (or Home, End) moves to, or null for another key. Wraps around. */
export function tabAfterKey(current: SettingsTab, key: string): SettingsTab | null {
  const index = SETTINGS_TABS.indexOf(current);
  const last = SETTINGS_TABS.length - 1;
  if (key === "ArrowRight") return SETTINGS_TABS[index === last ? 0 : index + 1]!;
  if (key === "ArrowLeft") return SETTINGS_TABS[index === 0 ? last : index - 1]!;
  if (key === "Home") return SETTINGS_TABS[0];
  if (key === "End") return SETTINGS_TABS[last]!;
  return null;
}

/** Whether a form differs from the one built from the saved settings (plain data: JSON-like comparison). */
export function isDirty(form: unknown, saved: unknown): boolean {
  return JSON.stringify(normalize(form)) !== JSON.stringify(normalize(saved));
}

/** Objects with their keys sorted, so that the order of the keys never makes a form dirty. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

// --- Numbers typed in a field -----------------------------------------------------

/** A decimal typed with a dot or a comma, or null when it is not one. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Empty, or a number more than 0. */
export const positiveOrEmpty = (text: string): boolean => text.trim() === "" || (parseDecimal(text) ?? 0) > 0;

const numberText = (value: number | null): string => (value === null ? "" : String(value));
const optionalNumber = (text: string): number | null => (text.trim() === "" ? null : parseDecimal(text));

// --- « Limites et coûts » -------------------------------------------------------------

export type LimitsForm = {
  scheduler: "env" | "on" | "off";
  cap: string;
  defaultBudget: string;
  weeklyBudget: string;
  timeout: string;
  hardLimit: string;
  portier: boolean;
  summaries: boolean;
};

export function limitsForm(settings: SettingsView): LimitsForm {
  const { scheduler, maxRunsPerDay, budgets } = settings;
  return {
    scheduler: scheduler.file === null ? "env" : scheduler.file ? "on" : "off",
    cap: numberText(maxRunsPerDay.file),
    defaultBudget: numberText(budgets.defaultMaxBudgetUsd.file),
    weeklyBudget: numberText(budgets.weeklyBudgetUsd.file),
    timeout: numberText(budgets.runTimeoutMinutes.file),
    hardLimit: numberText(budgets.runHardLimitMinutes.file),
    portier: settings.portier.enabled,
    summaries: settings.summaries.enabled,
  };
}

/** What is wrong in the form, by field, empty when it may be saved. */
export function limitsErrors(form: LimitsForm, settings: SettingsView): Partial<Record<keyof LimitsForm, true>> {
  const errors: Partial<Record<keyof LimitsForm, true>> = {};
  if (form.cap.trim() !== "" && !/^\d{1,6}$/.test(form.cap.trim())) errors.cap = true;
  for (const key of ["defaultBudget", "weeklyBudget", "timeout", "hardLimit"] as const) {
    if (!positiveOrEmpty(form[key])) errors[key] = true;
  }
  const timeout = optionalNumber(form.timeout) ?? settings.budgets.runTimeoutMinutes.fallback;
  const hard = optionalNumber(form.hardLimit) ?? settings.budgets.runHardLimitMinutes.fallback;
  if (!errors.timeout && !errors.hardLimit && timeout >= hard) errors.timeout = true;
  return errors;
}

export function limitsInput(form: LimitsForm) {
  return {
    scheduler: form.scheduler === "env" ? null : form.scheduler === "on",
    maxRunsPerDay: form.cap.trim() === "" ? null : Number(form.cap.trim()),
    defaultMaxBudgetUsd: optionalNumber(form.defaultBudget),
    weeklyBudgetUsd: optionalNumber(form.weeklyBudget),
    runTimeoutMinutes: optionalNumber(form.timeout),
    runHardLimitMinutes: optionalNumber(form.hardLimit),
    portier: form.portier,
    runSummaries: form.summaries,
  };
}

// --- A room's panel ---------------------------------------------------------------------

export type RoomAgentForm = { model: "opus" | "sonnet" | "haiku"; armed: boolean; budget: string };
export type RoomForm = { label: string; color: string; agents: Record<string, RoomAgentForm> };

export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type RoomView = SettingsView["rooms"][number];

export function roomForm(room: RoomView): RoomForm {
  return {
    label: room.label ?? "",
    color: room.color ?? "",
    agents: Object.fromEntries(
      room.agents.map((agent) => [agent.id, { model: agent.model, armed: agent.armed, budget: numberText(agent.maxBudgetUsd) }]),
    ),
  };
}

export function roomErrors(form: RoomForm): { color?: true; label?: true; budgets: string[] } {
  const errors: { color?: true; label?: true; budgets: string[] } = { budgets: [] };
  if (form.color !== "" && !HEX_COLOR.test(form.color)) errors.color = true;
  if (form.label.trim().length > 60) errors.label = true;
  for (const [id, agent] of Object.entries(form.agents)) if (!positiveOrEmpty(agent.budget)) errors.budgets.push(id);
  return errors;
}

export const roomHasErrors = (form: RoomForm): boolean => {
  const errors = roomErrors(form);
  return Boolean(errors.color || errors.label || errors.budgets.length > 0);
};

/** The body of `PUT /api/settings/rooms` for this room alone (the other rooms are left as they are). */
export function roomInput(room: RoomView, form: RoomForm) {
  return {
    rooms: [
      {
        name: room.name,
        label: form.label.trim() === "" ? null : form.label.trim(),
        color: form.color === "" ? null : form.color,
        agents: room.agents.map((agent) => {
          const each = form.agents[agent.id]!;
          return { id: agent.id, model: each.model, armed: each.armed, maxBudgetUsd: optionalNumber(each.budget) };
        }),
      },
    ],
  };
}

/** The name a room is shown by: its label, else its name. */
export const roomTitle = (room: { name: string; label: string | null }): string => room.label ?? room.name;

/** The rooms of a filter of the « Salles » tab. */
export const ROOM_FILTERS = ["all", "active", "paused"] as const;
export type RoomFilter = (typeof ROOM_FILTERS)[number];

export const filterRooms = <T extends { state: "active" | "paused" }>(rooms: readonly T[], filter: RoomFilter): T[] =>
  filter === "all" ? [...rooms] : rooms.filter((room) => room.state === filter);

/**
 * The form once the saved settings changed under it (a save of another tab,
 * a gesture on a room): every value the owner did not touch (still equal to
 * the previous saved one) takes the new saved one; a value they changed
 * stays; a key that left the settings leaves the form, a new one comes in.
 */
export function rebase<T>(current: T, previous: T, next: T): T {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject(current) && isObject(previous) && isObject(next)) {
    return Object.fromEntries(
      Object.keys(next).map((key) => [
        key,
        key in current && key in previous ? rebase(current[key], previous[key], next[key]) : next[key],
      ]),
    ) as T;
  }
  return isDirty(current, previous) ? current : next;
}
