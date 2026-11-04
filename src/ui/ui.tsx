import type { ReactNode } from "react";

type Variant = "primary" | "danger" | "neutral";

const base =
  "inline-flex min-h-10 pointer-coarse:min-h-12 items-center justify-center rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "border-accent bg-accent text-accent-fg hover:opacity-90",
  danger: "border-danger text-danger hover:bg-danger-soft",
  neutral: "border-line hover:bg-soft",
};

export const buttonClass = (variant: Variant = "neutral"): string => `${base} ${variants[variant]}`;

export const fieldClass =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "accent" | "neutral"; children: ReactNode }) {
  const tones = {
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    accent: "bg-accent-soft text-accent",
    neutral: "bg-soft text-muted",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
