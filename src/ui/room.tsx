"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { placeAgents, type AgentGroup } from "./agent-groups";
import { AgentSheet } from "./agent-sheet";
import { ChatPanel, ChatToggle, useChatToggle } from "./chat-panel";
import { parseHash } from "./deep-link";
import { pileHref } from "./floor-mode";
import { JANITOR_SHEET, neutralPersonFor, RECEPTIONIST_SHEET } from "./iso-floor";
import { pendingTitle, selectAgents, selectPending, selectUnseen } from "./model";
import { OWNER_KEY, RECEPTION_AGENT, RECEPTION_KEY, RECEPTION_ROOM } from "./reception";
import { ReceptionSheet } from "./reception-sheet";
import { RoomCanvas } from "./room-canvas";
import { RoomSheet } from "./room-sheet";
import { roomDigest, type SheetAgentInput } from "./room-sheet-model";
import { chipStyle } from "./room-color";
import { buildBoard } from "./room-board";
import type { AgentStatus, AgentView, Coarse, RoomView } from "./room-model";
import { FLOOR_MODEL, snapshotRoom } from "./room-model";
import { createRoomStore, type RoomStore } from "./room-store";
import { strings } from "./strings";
import { SiteNav } from "./site-nav";
import { buttonClass, ErrorNote } from "./ui";
import { fetchChatTurn } from "./api";
import { useDesk } from "./use-desk";
import { useHq } from "./use-hq";
import { useFlip } from "./use-flip";
import { useMediaQuery } from "./use-media-query";

const t = strings.room;

/** The wording of what an agent is doing; the receptionist is at its desk, not at a table. */
export function statusText(status: AgentStatus, receptionist = false): string {
  if (receptionist && (status.kind === "seated" || status.kind === "returning")) return t.reception.status[status.kind];
  switch (status.kind) {
    case "visiting":
      return t.status.visiting(status.target);
    case "talking":
      return t.status.talking(status.target);
    default:
      return t.status[status.kind];
  }
}

const coarseId = (coarse: Coarse): string => (coarse.kind === "visiting" ? `visiting:${coarse.target}` : coarse.kind);

function announcement(agent: AgentView): string {
  const { coarse, name } = agent;
  return coarse.kind === "visiting" ? t.announce.visiting(name, coarse.target) : t.announce[coarse.kind](name);
}

type Snapshot = { view: RoomView; announcement: string };

/**
 * The room as the page's text sees it, recomputed when the model changes and
 * when something in it ends by itself (a bubble, a trip, the sleep), outside
 * the canvas loop. The announcement is the last change of coarse state, said
 * once to a screen reader (typing and thinking come and go too often to be).
 */
function useRoomSnapshot(store: RoomStore, room: string | null, reduced: boolean): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (room === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let said = "";
    const seen = new Map<string, string>();
    const update = () => {
      clearTimeout(timer);
      const now = Date.now();
      const view = snapshotRoom(store.get(room), now, reduced);
      for (const agent of view.agents) {
        const id = coarseId(agent.coarse);
        const before = seen.get(agent.key);
        seen.set(agent.key, id);
        if (before !== undefined && before !== id) said = announcement(agent);
      }
      setSnapshot({ view, announcement: said });
      if (Number.isFinite(view.nextChangeAt)) timer = setTimeout(update, Math.max(100, view.nextChangeAt - now));
    };
    const first = setTimeout(update, 0);
    const unsubscribe = store.subscribe(update);
    return () => {
      clearTimeout(first);
      clearTimeout(timer);
      unsubscribe();
    };
  }, [store, room, reduced]);

  return snapshot;
}

/** The name of a room of the home as the floor shows it: the onboarding room is the reception. */
const roomLabel = (room: string): string => (room === RECEPTION_ROOM ? t.reception.name : room);

export function RoomPage() {
  const [store] = useState<RoomStore>(createRoomStore);
  const { model, dispatch, connection, loadError, retry, subscribeChat, subscribeDesk } = useHq((change) =>
    store.ingest(change, Date.now()),
  );
  const agents = useMemo(() => selectAgents(model), [model]);
  const router = useRouter();

  // The floor is the home page; the links of the alerts and the old bookmarks of the desk (`/#approval-<id>`,
  // `/#run-<id>`) open the item on the desk page.
  useEffect(() => {
    const follow = () => {
      if (parseHash(window.location.hash)) router.replace(`/bureau${window.location.hash}`);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [router]);

  const roomNames = useMemo(() => model.rooms.map((room) => room.name), [model.rooms]);
  const roomColors = useMemo(() => new Map(model.rooms.map((each) => [each.name, each.color])), [model.rooms]);
  // The single floor of the home: every room on one floor, the buttons at the top take the view to a room.
  const single = model.floorLayout === "room-per-project";
  const { desk } = useDesk(subscribeDesk);
  const [focus, setFocus] = useState<{ room: string; seq: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const room = single ? (roomNames.length > 0 ? FLOOR_MODEL : null) : chosen !== null && roomNames.includes(chosen) ? chosen : (roomNames[0] ?? null);
  const roomAgents = useMemo(() => (single ? agents : agents.filter((agent) => agent.room === room)), [agents, room, single]);

  const wide = useMediaQuery("(min-width: 40rem)");
  const chat = useChatToggle();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  // A room chosen on a phone: the floor opens under the band, bring it into view.
  useEffect(() => {
    if (focus === null || wide) return;
    stageRef.current?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [focus, wide, reduced]);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = roomAgents.find((agent) => agent.key === selectedKey) ?? null;
  // The reception desk is drawn on one floor of the home only (reception.room of myhq.json).
  const receptionHere = model.reception.room !== null && (single || model.reception.room === room);
  const roomColor = single ? null : (chipStyle(room === null ? null : roomColors.get(room))?.["--room-color"] ?? null);
  const closeSheet = useCallback(() => setSelectedKey(null), []);
  // The owner seated in the user's office of the single floor (myhq.json `floor.owner`): a click opens the chat.
  const owner = single ? model.floorOwner : null;
  const { open: chatOpen, toggle: toggleChat } = chat;
  const selectOnFloor = useCallback(
    (key: string) => {
      if (key !== OWNER_KEY) setSelectedKey(key);
      else if (!chatOpen) toggleChat();
    },
    [chatOpen, toggleChat],
  );
  // The owner types while a turn of the chat is in progress: the turn state at each (re)connection, then its events.
  const hasOwner = owner !== null;
  useEffect(() => {
    if (!hasOwner) return;
    let closed = false;
    const load = () => {
      fetchChatTurn()
        .then((turn) => {
          if (!closed) store.setOwnerBusy(turn.running, Date.now());
        })
        .catch(() => {});
    };
    const unsubscribe = subscribeChat((signal) => {
      if (signal.type === "ready") load();
      else if (signal.type === "turn") store.setOwnerBusy(signal.turn.running, Date.now());
    });
    load();
    return () => {
      closed = true;
      unsubscribe();
    };
  }, [hasOwner, subscribeChat, store]);
  // The sheet of a room of the single floor (a click on the room or its button), under an agent's sheet opened from it.
  const [sheetRoom, setSheetRoom] = useState<string | null>(null);
  const openRoomSheet = useCallback((name: string | null) => {
    setSheetRoom(name);
    if (name !== null) setSelectedKey(null);
  }, []);
  const closeRoomSheet = useCallback(() => setSheetRoom(null), []);

  const snapshot = useRoomSnapshot(store, room, reduced);

  // The tab says how many items wait, as the desk's did when it was the home page.
  const waiting = useMemo(() => selectPending(model).length, [model]);
  const unseen = useMemo(() => selectUnseen(model).length, [model]);
  useEffect(() => {
    document.title = pendingTitle(t.pageTitle, waiting, unseen);
  }, [waiting, unseen]);

  const board = useMemo(
    () =>
      room === null
        ? []
        : buildBoard({ room: single ? null : room, agents, usage: model.usage, firings: model.firings, schedulerEnabled: model.scheduler.enabled }),
    [room, single, agents, model.usage, model.firings, model.scheduler.enabled],
  );
  const boardForCanvas = useMemo(() => ({ title: t.board.title, rows: board }), [board]);
  const sprites = useMemo(
    () => ({
      // An agent's own iso sheet (`isoSprite`), or the janitor for one that roams the floor, or a neutral person picked from its key.
      ...Object.fromEntries(
        roomAgents.map((agent) => [agent.key, agent.isoSprite ?? (agent.roam ? JANITOR_SHEET : neutralPersonFor(agent.key))]),
      ),
      ...(receptionHere ? { [RECEPTION_KEY]: RECEPTIONIST_SHEET } : {}),
      ...(owner ? { [OWNER_KEY]: owner.isoSprite ?? neutralPersonFor(OWNER_KEY) } : {}),
    }),
    [roomAgents, receptionHere, owner],
  );
  const strides = useMemo(
    () =>
      Object.fromEntries(
        roomAgents.flatMap((agent) => (agent.isoSprite && agent.isoStride ? [[agent.key, agent.isoStride] as const] : [])),
      ),
    [roomAgents],
  );
  const statusOf = useMemo(
    () => new Map(snapshot?.view.agents.map((agent) => [agent.key, agent]) ?? []),
    [snapshot],
  );
  // The strip under the floor: the agents at work first, then the ones that wait, then the ones asleep (the order of the home inside each).
  const strip = useMemo(
    () =>
      placeAgents(
        [...roomAgents.map((agent) => ({ key: agent.key, agent })), ...(receptionHere ? [{ key: RECEPTION_KEY, agent: null }] : [])],
        (entry) => statusOf.get(entry.key)?.status ?? null,
      ),
    [roomAgents, receptionHere, statusOf],
  );
  const stripRef = useRef<HTMLUListElement>(null);
  useFlip(stripRef, strip.map(({ item }) => item.key).join("|"), !reduced);
  const pending = snapshot?.view.pending ?? 0;
  const pendingByRoom = snapshot?.view.pendingByRoom ?? {};
  const showCanvas = room !== null && roomAgents.length > 0 && (wide || narrowOpen);
  const deskObjects = useMemo(
    () => desk?.objects.map((object) => ({ id: object.id, source: object.source })) ?? null,
    [desk],
  );
  const openPile = useCallback((name: string) => router.push(pileHref(deskObjects, name)), [router, deskObjects]);
  const openDesk = useCallback(() => router.push("/bureau"), [router]);
  // The logos of the rooms' projects, for their signboards; the letters of the desk's tray, for the tray of the user's office.
  const logos = useMemo(
    () => Object.fromEntries(model.rooms.flatMap((each) => (each.logo ? [[each.name, each.logo] as const] : []))),
    [model.rooms],
  );
  const officeTray = desk?.objects.find((object) => object.object === "tray")?.count ?? 0;
  // The users' desks of the single floor, in the order of the home, the reception's last.
  const piles = useMemo(
    () => (single ? [...roomNames, ...(model.reception.room !== null ? [RECEPTION_ROOM] : [])] : []),
    [single, roomNames, model.reception.room],
  );
  const labels = useMemo(
    () => ({ userDesk: t.userDesk, trayCount: t.trayCount, roomSign: roomLabel, officeSign: t.userDesk }),
    [],
  );

  // What the sheet of the room says, rebuilt with the model (the stream keeps it live).
  const pendingApprovals = useMemo(() => selectPending(model), [model]);
  const sheet = useMemo(() => {
    if (!single || sheetRoom === null) return null;
    const reception = sheetRoom === RECEPTION_ROOM;
    if (reception ? model.reception.room === null : !roomNames.includes(sheetRoom)) return null;
    const receptionRun = model.reception.runs[0] ?? null;
    const members: SheetAgentInput[] = reception
      ? [{ key: RECEPTION_KEY, id: RECEPTION_AGENT, name: t.reception.name, lastRun: receptionRun, armed: false, routines: [] }]
      : roomAgents.filter((agent) => agent.room === sheetRoom);
    const blocked = new Set(snapshot?.view.agents.filter((agent) => agent.status.kind === "blocked").map((agent) => agent.key) ?? []);
    return {
      name: roomLabel(sheetRoom),
      color: reception ? null : (roomColors.get(sheetRoom) ?? null),
      logo: reception ? null : (model.rooms.find((each) => each.name === sheetRoom)?.logo ?? null),
      href: pileHref(deskObjects, sheetRoom),
      digest: roomDigest({
        room: sheetRoom,
        agents: members,
        pending: snapshot?.view.pendingByRoom[sheetRoom] ?? 0,
        approvals: pendingApprovals,
        events: model.events,
        usage: model.usage,
        blocked,
      }),
    };
  }, [single, sheetRoom, model.reception, model.rooms, model.events, model.usage, roomNames, roomAgents, roomColors, snapshot, pendingApprovals, deskObjects]);

  // The items of the agent whose sheet is open, by id and status: its thread is read again when one comes or is decided.
  const selectedItems = useMemo(
    () =>
      selected === null
        ? ""
        : Object.values(model.approvals)
            .filter((approval) => approval.room === selected.room && approval.agentId === selected.id)
            .map((approval) => `${approval.id}:${approval.status}`)
            .sort()
            .join(","),
    [selected, model.approvals],
  );

  const title = room === null || single ? t.title : t.floorTitle(room);

  return (
    <div className="chat-shell">
    <div className="wall-page room-page chat-main" inert={chat.open && !wide}>
      <header className="room-top">
        <SiteNav current="floor" />
        {/* The nav already says "L'étage": the title shows only when it adds a room name, and stays for screen readers. */}
        <h1 className={title === strings.nav.floor ? "sr-only" : "room-title wall-display"}>{title}</h1>
        {model.loaded && single && roomNames.length > 0 && (
          <div className="room-rooms" role="group" aria-label={t.single.roomsLabel}>
            {roomNames.map((name) => {
              const tint = chipStyle(roomColors.get(name));
              const count = pendingByRoom[name] ?? 0;
              return (
                <button
                  key={name}
                  type="button"
                  className="wall-filter"
                  data-tint={tint ? "" : undefined}
                  style={tint ?? undefined}
                  aria-label={count > 0 ? t.single.goToWithCount(name, count) : t.single.goTo(name)}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setFocus((before) => ({ room: name, seq: (before?.seq ?? 0) + 1 }));
                    openRoomSheet(name);
                    // On a phone the floor is under the band: open it (brought into view below).
                    if (!wide) setNarrowOpen(true);
                  }}
                >
                  {tint && <span className="room-swatch" aria-hidden />}
                  {name}
                  {count > 0 && (
                    <span className="wall-filter-count" aria-hidden>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {model.loaded && !single && roomNames.length > 1 && (
          <div className="room-rooms" role="group" aria-label={t.roomsLabel}>
            {roomNames.map((name) => {
              const tint = chipStyle(roomColors.get(name));
              return (
                <button
                  key={name}
                  type="button"
                  className="wall-filter"
                  aria-pressed={name === room}
                  data-tint={tint ? "" : undefined}
                  style={tint ?? undefined}
                  onClick={() => setChosen(name)}
                >
                  {tint && <span className="room-swatch" aria-hidden />}
                  {name}
                </button>
              );
            })}
          </div>
        )}
        <p className="wall-live room-live" role="status" data-connected={connection === "live" ? "" : undefined}>
          <span className="wall-live-dot" aria-hidden />
          {strings.app.connection[connection]}
        </p>
        <ChatToggle open={chat.open} onClick={chat.toggle} buttonRef={chat.toggleRef} />
      </header>

      <div className="room-main">
        {loadError && (
          <div className="space-y-3">
            <ErrorNote>
              {strings.app.loadFailed} {loadError}
            </ErrorNote>
            <button type="button" className={buttonClass()} onClick={retry}>
              {strings.app.retry}
            </button>
          </div>
        )}
        {!model.loaded && !loadError && <p className="wall-empty-text">{strings.app.loading}</p>}
        {model.loaded && room !== null && roomAgents.length === 0 && <p className="wall-empty-text">{t.noAgents}</p>}

        {model.loaded && room !== null && roomAgents.length > 0 && (
          <>
            {!wide && (
              <section className="room-band" aria-label={t.band.title}>
                <dl className="room-band-board">
                  {board.map((row) => (
                    <div key={row.key}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="room-band-tray">
                  <span className="room-band-count">{pending}</span> {t.trayCount(pending)}
                </p>
                <button type="button" className={buttonClass()} aria-expanded={narrowOpen} onClick={() => setNarrowOpen(!narrowOpen)}>
                  {narrowOpen ? t.band.hide : t.band.show}
                </button>
              </section>
            )}

            {showCanvas && (
              <div className="room-stage" ref={stageRef}>
                {canvasFailed ? (
                  <p className="wall-empty-text">{t.rendering.failed}</p>
                ) : (
                  <RoomCanvas
                    store={store}
                    room={room}
                    board={boardForCanvas}
                    labels={labels}
                    sprites={sprites}
                    strides={strides}
                    color={roomColor}
                    selected={selectedKey}
                    reduced={reduced}
                    onSelect={selectOnFloor}
                    onFailure={() => setCanvasFailed(true)}
                    onCounter={single ? openPile : undefined}
                    onOffice={openDesk}
                    logos={logos}
                    officeTray={officeTray}
                    focus={single ? focus : null}
                    onRoom={single ? openRoomSheet : undefined}
                    sheetOpen={sheet !== null}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {model.loaded && room !== null && roomAgents.length > 0 && (
        <section className="room-strip" aria-labelledby="room-agents">
          <h2 id="room-agents" className="sr-only">
            {t.listTitle}
          </h2>
          <ul className="room-agents" ref={stripRef}>
            {strip.map(({ item, label }) =>
              item.agent ? (
                <AgentRow
                  key={item.key}
                  id={item.key}
                  name={item.agent.name}
                  color={item.agent.color}
                  status={statusOf.get(item.key)?.status ?? null}
                  label={label}
                  selected={item.key === selectedKey}
                  onOpen={() => setSelectedKey(item.key)}
                />
              ) : (
                <AgentRow
                  key={RECEPTION_KEY}
                  id={RECEPTION_KEY}
                  name={t.reception.name}
                  status={statusOf.get(RECEPTION_KEY)?.status ?? null}
                  label={label}
                  receptionist
                  selected={selectedKey === RECEPTION_KEY}
                  onOpen={() => setSelectedKey(RECEPTION_KEY)}
                />
              ),
            )}
          </ul>
          {wide && !single && <p className="room-strip-tray">{t.trayCount(pending)}</p>}
          {single && (
            <nav className="room-piles" aria-label={t.single.pilesTitle}>
              {piles.map((name) => {
                const count = pendingByRoom[name] ?? 0;
                return (
                  <Link key={name} href={pileHref(deskObjects, name)} className="room-pile" data-empty={count === 0 ? "" : undefined}>
                    {t.single.pile(roomLabel(name), count)}
                  </Link>
                );
              })}
            </nav>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {snapshot?.announcement ?? ""}
          </p>
        </section>
      )}

      {sheet && selectedKey === null && (
        <RoomSheet
          key={sheetRoom}
          name={sheet.name}
          color={sheet.color}
          logo={sheet.logo}
          digest={sheet.digest}
          pileHref={sheet.href}
          schedulerEnabled={model.scheduler.enabled}
          onOpenAgent={setSelectedKey}
          onClose={closeRoomSheet}
        />
      )}
      {selected && (
        <AgentSheet
          key={selected.key}
          agent={selected}
          events={model.events}
          dispatch={dispatch}
          onClose={closeSheet}
          asleep={statusOf.get(selected.key)?.status.kind === "asleep"}
          refreshKey={selectedItems}
        />
      )}
      {receptionHere && selectedKey === RECEPTION_KEY && (
        <ReceptionSheet key={RECEPTION_KEY} runs={model.reception.runs} dispatch={dispatch} onClose={closeSheet} />
      )}
    </div>
    {chat.mounted && (
      <ChatPanel open={chat.open} onClose={chat.close} subscribe={subscribeChat} agents={roomAgents} narrow={!wide} />
    )}
    </div>
  );
}

/** One agent of the list under the floor: a button with its name and what it is doing, that opens its sheet. */
function AgentRow({
  id,
  name,
  color = null,
  status,
  label,
  selected,
  onOpen,
  receptionist = false,
}: {
  /** Key of the agent, to follow the chip when the strip is reordered. */
  id: string;
  name: string;
  /** Colour of the agent's room; the receptionist has none. */
  color?: string | null;
  status: AgentStatus | null;
  /** The group this chip opens in the strip, named above it; null inside a group. */
  label: AgentGroup | null;
  selected: boolean;
  onOpen: () => void;
  receptionist?: boolean;
}) {
  const tint = chipStyle(color);
  return (
    <li className="room-agents-item" data-flip={id} data-group-start={label ? "" : undefined}>
      {label && (
        <span className="room-agents-label" aria-hidden="true">
          {t.groups[label]}
        </span>
      )}
      <button
        type="button"
        className="room-agent"
        data-state={status?.kind}
        data-tint={tint ? "" : undefined}
        style={tint ?? undefined}
        aria-expanded={selected}
        aria-haspopup="dialog"
        title={t.openCard(name)}
        onClick={onOpen}
      >
        <span className="room-agent-name">{name}</span>
        <span className="room-agent-status">{status ? statusText(status, receptionist) : ""}</span>
      </button>
    </li>
  );
}
