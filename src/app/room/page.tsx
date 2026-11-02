import type { Metadata } from "next";
import { RoomPage } from "@/ui/room";
import { strings } from "@/ui/strings";
import { wallBody, wallDisplay } from "../roadmap/fonts";

export const metadata: Metadata = { title: strings.room.pageTitle };

export default function Room() {
  return (
    <main className={`wall flex-1 ${wallDisplay.variable} ${wallBody.variable}`}>
      <RoomPage />
    </main>
  );
}
