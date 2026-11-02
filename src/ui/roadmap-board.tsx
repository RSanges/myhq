import type { CSSProperties } from "react";
import type { RoadmapEvent, RoadmapOpenPoint } from "@/server/roadmap-schema";
import { formatDay } from "./format";
import { eventKey, eventParts, groupEventsByDay, openPointKeys } from "./roadmap-model";
import { flash } from "./roadmap-parts";
import { strings } from "./strings";

const t = strings.roadmap;

/** Open points as sticky notes pinned on the wall. */
export function OpenNotes({ points, changed }: { points: RoadmapOpenPoint[]; changed: ReadonlySet<string> }) {
  const keys = openPointKeys(points);
  return (
    <section className="wall-panel" aria-labelledby="wall-notes-title">
      <h2 id="wall-notes-title" className="wall-panel-title wall-display">
        {t.openPointsTitle}
        <span className="wall-panel-count">{points.length}</span>
      </h2>
      {points.length === 0 ? (
        <p className="wall-empty-text">{t.noOpenPoints}</p>
      ) : (
        <ul className="wall-notes">
          {points.map((point, index) => (
            <li
              key={keys.get(point)}
              className={`wall-note${flash(changed, keys.get(point)!)}`}
              data-status={point.status === "ouvert" ? "open" : "settled"}
              style={{ "--i": index } as CSSProperties}
            >
              <span className="wall-note-tag">{t.openPointStatus[point.status]}</span>
              <span className="wall-note-name">{point.name}</span>
              {point.note !== "" && <span className="wall-note-text">{point.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The journal as a vertical timeline, newest first, with a time mark on each entry. */
export function Journal({ events, changed }: { events: RoadmapEvent[]; changed: ReadonlySet<string> }) {
  const days = groupEventsByDay(events);
  return (
    <section className="wall-panel" aria-labelledby="wall-journal-title">
      <h2 id="wall-journal-title" className="wall-panel-title wall-display">
        {t.eventsTitle}
        <span className="wall-panel-count">{events.length}</span>
      </h2>
      {events.length === 0 ? (
        <p className="wall-empty-text">{t.noEvents}</p>
      ) : (
        <ol className="wall-days">
          {days.map((group, dayIndex) => (
            <li key={`${group.day ?? "?"}-${dayIndex}`} className="wall-day">
              {group.day && <h3 className="wall-day-label">{formatDay(group.day)}</h3>}
              <ol className="wall-entries">
                {group.events.map((event, index) => {
                  const { time } = eventParts(event.at);
                  return (
                    <li
                      key={`${eventKey(event)}#${index}`}
                      className={`wall-entry${flash(changed, eventKey(event))}`}
                      data-latest={dayIndex === 0 && index === 0 ? "" : undefined}
                    >
                      <time className="wall-entry-time" dateTime={event.at}>
                        {time ?? event.at}
                      </time>
                      <span className="wall-entry-text">{event.text}</span>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
