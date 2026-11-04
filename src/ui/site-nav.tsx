import Link from "next/link";
import { strings } from "./strings";

// The navigation between the pages of MyHQ, the same in the header of every
// page: the floor (the home page), the desk, the roadmap and the settings.
// The page shown is marked (aria-current) and stays a link, so a module page
// of the desk goes back to the desk with the same words.

export type SitePage = "floor" | "desk" | "roadmap" | "settings";

const t = strings.nav;

const LINKS: { page: SitePage; href: string; label: string }[] = [
  { page: "floor", href: "/", label: t.floor },
  { page: "desk", href: "/bureau", label: t.desk },
  { page: "roadmap", href: "/roadmap", label: t.roadmap },
  { page: "settings", href: "/reglages", label: t.settings },
];

export function SiteNav({ current }: { current: SitePage | null }) {
  return (
    <nav aria-label={t.label} className="site-nav">
      {LINKS.map((link) => (
        <Link key={link.page} href={link.href} aria-current={link.page === current ? "page" : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
