import type { Metadata } from "next";
import { LiveRoomView } from "@/ui/live-room";
import { strings } from "@/ui/strings";
import { wallBody, wallDisplay } from "../roadmap/fonts";

export const metadata: Metadata = { title: strings.live.pageTitle };

/** The surveillance room: the agents at work right now, each with its piece (docs/architecture.md). */
export default function SurveillancePage() {
  return (
    <div className={`wall flex-1 ${wallDisplay.variable} ${wallBody.variable}`}>
      <LiveRoomView />
    </div>
  );
}
