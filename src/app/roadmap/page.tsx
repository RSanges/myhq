import type { Metadata } from "next";
import { RoadmapView } from "@/ui/roadmap";
import { strings } from "@/ui/strings";
import { wallBody, wallDisplay } from "./fonts";

export const metadata: Metadata = { title: strings.roadmap.pageTitle };

export default function RoadmapPage() {
  return (
    <main className={`wall flex-1 ${wallDisplay.variable} ${wallBody.variable}`}>
      <RoadmapView />
    </main>
  );
}
