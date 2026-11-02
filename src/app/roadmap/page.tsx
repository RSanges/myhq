import type { Metadata } from "next";
import { RoadmapView } from "@/ui/roadmap";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.roadmap.pageTitle };

export default function RoadmapPage() {
  return (
    <main className="flex-1">
      <RoadmapView />
    </main>
  );
}
