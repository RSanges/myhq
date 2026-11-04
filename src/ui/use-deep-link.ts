"use client";

import { useEffect, useState } from "react";
import { parseHash, type DeepLink } from "./deep-link";

/** A deep link read from the address, and a counter so that the same link followed twice is handled twice. */
export type DeepLinkTarget = { link: DeepLink; nonce: number };

/**
 * The deep link of the address bar (`#approval-<id>`, `#run-<id>`), read on
 * load and on each `hashchange`. The hash itself is never touched, so it stays
 * in the address whatever the page does with the data it receives.
 */
export function useDeepLink(): DeepLinkTarget | null {
  const [target, setTarget] = useState<DeepLinkTarget | null>(null);
  useEffect(() => {
    let nonce = 0;
    const read = () => {
      const link = parseHash(window.location.hash);
      setTarget(link ? { link, nonce: ++nonce } : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return target;
}
