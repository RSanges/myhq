"use client";

import { useState } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { saveSettingsGroup } from "./api";
import { Field, FieldError, GroupCard } from "./settings-parts";
import { strings } from "./strings";
import { buttonClass, fieldClass } from "./ui";

const t = strings.settings.rooms;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MODELS = ["opus", "sonnet", "haiku"] as const;

/** The value of an `<input type="color">` (always #rrggbb) for a #rgb or #rrggbb code. */
function pickerValue(hex: string): string {
  if (!HEX.test(hex)) return "#000000";
  if (hex.length === 7) return hex.toLowerCase();
  return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
}

type AgentForm = { model: (typeof MODELS)[number]; armed: boolean; budget: string };
type RoomForm = { color: string; agents: Record<string, AgentForm> };

const budgetValid = (budget: string): boolean => budget.trim() === "" || (Number(budget.trim()) > 0 && Number.isFinite(Number(budget.trim())));

type Props = { settings: SettingsView; onSaved: (settings: SettingsView) => void };

/** « Salles et agents »: colour of each room, model, routines and budget of each agent. */
export function RoomsAndAgents({ settings, onSaved }: Props) {
  const [forms, setForms] = useState<Record<string, RoomForm>>(() =>
    Object.fromEntries(
      settings.rooms.map((room) => [
        room.name,
        {
          color: room.color ?? "",
          agents: Object.fromEntries(
            room.agents.map((agent) => [
              agent.id,
              { model: agent.model, armed: agent.armed, budget: agent.maxBudgetUsd === null ? "" : String(agent.maxBudgetUsd) },
            ]),
          ),
        },
      ]),
    ),
  );

  const patchRoom = (room: string, patch: Partial<RoomForm>) =>
    setForms((current) => ({ ...current, [room]: { ...current[room]!, ...patch } }));
  const patchAgent = (room: string, agent: string, patch: Partial<AgentForm>) =>
    setForms((current) => ({
      ...current,
      [room]: { ...current[room]!, agents: { ...current[room]!.agents, [agent]: { ...current[room]!.agents[agent]!, ...patch } } },
    }));

  const colorOk = (room: string) => forms[room]!.color === "" || HEX.test(forms[room]!.color);
  const invalid = settings.rooms.some(
    (room) => !colorOk(room.name) || room.agents.some((agent) => !budgetValid(forms[room.name]!.agents[agent.id]!.budget)),
  );

  return (
    <GroupCard
      id="rooms"
      title={t.title}
      hint={t.hint}
      blocked={invalid}
      onSave={async () => {
        onSaved(
          await saveSettingsGroup("rooms", {
            rooms: settings.rooms.map((room) => ({
              name: room.name,
              color: forms[room.name]!.color === "" ? null : forms[room.name]!.color,
              agents: room.agents.map((agent) => {
                const form = forms[room.name]!.agents[agent.id]!;
                return {
                  id: agent.id,
                  model: form.model,
                  armed: form.armed,
                  maxBudgetUsd: form.budget.trim() === "" ? null : Number(form.budget.trim()),
                };
              }),
            })),
          }),
        );
      }}
    >
      {settings.rooms.length === 0 && <p className="text-sm text-muted">{t.empty}</p>}
      {settings.rooms.map((room) => {
        const form = forms[room.name]!;
        const colorId = `color-${room.name}`;
        return (
          <section key={room.name} className="min-w-0 space-y-3 rounded-md border border-line p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="text-sm font-semibold">{room.name}</h3>
              {room.shared && <span className="rounded-full bg-soft px-2 py-0.5 text-xs text-muted">{t.shared}</span>}
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={colorId} className="block text-sm font-medium">
                {t.color}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-label={t.colorPicker(room.name)}
                  value={pickerValue(form.color)}
                  onChange={(event) => patchRoom(room.name, { color: event.target.value })}
                  className="h-10 w-12 cursor-pointer rounded-md border border-line bg-card p-1"
                />
                <input
                  id={colorId}
                  aria-label={t.colorHex(room.name)}
                  className={`${fieldClass} max-w-32`}
                  value={form.color}
                  placeholder={t.neutral}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!colorOk(room.name)}
                  aria-describedby={colorOk(room.name) ? undefined : `${colorId}-error`}
                  onChange={(event) => patchRoom(room.name, { color: event.target.value.trim() })}
                />
                <button type="button" className={buttonClass()} onClick={() => patchRoom(room.name, { color: "" })} disabled={form.color === ""}>
                  {t.colorNone}
                </button>
              </div>
              {!colorOk(room.name) && <FieldError id={`${colorId}-error`}>{t.colorInvalid}</FieldError>}
            </div>

            <ul className="space-y-3">
              {room.agents.map((agent) => {
                const agentForm = form.agents[agent.id]!;
                const base = `${room.name}-${agent.id}`;
                const okBudget = budgetValid(agentForm.budget);
                return (
                  <li key={agent.id} className="min-w-0 space-y-3 border-t border-line pt-3">
                    <p className="text-sm font-medium">
                      {agent.name} <code className="text-xs text-muted">{agent.id}</code>
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label={t.model} htmlFor={`model-${base}`}>
                        <select
                          id={`model-${base}`}
                          className={fieldClass}
                          value={agentForm.model}
                          onChange={(event) => patchAgent(room.name, agent.id, { model: event.target.value as AgentForm["model"] })}
                        >
                          {MODELS.map((model) => (
                            <option key={model} value={model}>
                              {t.modelNames[model]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t.budget} htmlFor={`budget-${base}`}>
                        <input
                          id={`budget-${base}`}
                          className={fieldClass}
                          inputMode="decimal"
                          value={agentForm.budget}
                          placeholder={t.budgetDefault(settings.defaultMaxBudgetUsd)}
                          aria-invalid={!okBudget}
                          aria-describedby={okBudget ? undefined : `budget-${base}-error`}
                          onChange={(event) => patchAgent(room.name, agent.id, { budget: event.target.value })}
                        />
                        {!okBudget && <FieldError id={`budget-${base}-error`}>{t.budgetInvalid}</FieldError>}
                      </Field>
                      <div className="min-w-0 space-y-1.5">
                        <span className="block text-sm font-medium">{t.armed}</span>
                        {agent.hasRoutines ? (
                          <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 text-sm hover:bg-soft">
                            <input
                              type="checkbox"
                              checked={agentForm.armed}
                              onChange={(event) => patchAgent(room.name, agent.id, { armed: event.target.checked })}
                              className="accent-accent"
                            />
                            <span>{agentForm.armed ? t.armedOn : t.armedOff}</span>
                          </label>
                        ) : (
                          <p className="flex min-h-10 items-center text-sm text-muted">{t.noRoutine}</p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-muted">{t.armedHint}</p>
      {settings.invalidRooms.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{strings.settings.invalidRoomsTitle}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted break-words">
            {settings.invalidRooms.map((invalidRoom) => (
              <li key={invalidRoom.name}>
                <code>{invalidRoom.name}</code>: {invalidRoom.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </GroupCard>
  );
}
