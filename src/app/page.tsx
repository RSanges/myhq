import { strings } from "@/ui/strings";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-lg">{strings.app.placeholder}</p>
    </main>
  );
}
