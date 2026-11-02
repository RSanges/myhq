import type { Metadata } from "next";
import { strings } from "@/ui/strings";
import "./globals.css";

export const metadata: Metadata = {
  title: strings.app.title,
  description: strings.app.description,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
