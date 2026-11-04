import type { Metadata } from "next";
import { RoomPage } from "@/ui/room";
import { strings } from "@/ui/strings";
import { wallBody, wallDisplay } from "./roadmap/fonts";

export const metadata: Metadata = { title: strings.room.pageTitle };

/** The home page: the floor, where each room of the home works (docs/architecture.md, section 7); the desk is /bureau. */
export default function Floor() {
  return (
    <main className={`wall flex-1 ${wallDisplay.variable} ${wallBody.variable}`}>
      <RoomPage />
    </main>
  );
}
