"use client";

// Three-state theme control: system → light → dark → system. "System" follows
// the device's prefers-color-scheme (the default); "light"/"dark" force a theme
// via a data-theme attribute on <html> that wins over the OS. The choice is
// persisted in localStorage and re-applied on load by an inline no-flash script
// in app/layout.tsx, so this component only keeps the glyph in sync and writes
// the next choice. Unicode affordance glyphs (no emoji), matching the cockpit.
import { useEffect, useSyncExternalStore } from "react";

type Choice = "system" | "light" | "dark";

const KEY = "wasabi-theme";
const ORDER: Choice[] = ["system", "light", "dark"];
const GLYPH: Record<Choice, string> = { system: "◐", light: "☀", dark: "☾" };
const NAME: Record<Choice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** Reflect a choice onto <html>: remove the attribute for system, set it otherwise. */
function apply(choice: Choice) {
  const el = document.documentElement;
  if (choice === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", choice);
}

function readStored(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private windows throw on access — fall through to system. */
  }
  return "system";
}

// ---------------------------------------------------------------------------
// useSyncExternalStore plumbing — reads the persisted choice as external
// state instead of mirroring it into useState via an effect. This is what
// keeps the component free of react-hooks/set-state-in-effect: React itself
// renders the server/first-paint value from getServerSnapshot ("system",
// matching the no-flash default) during hydration, then swaps in the real
// client value on its own once mounted — no manual "mounted" flag and no
// setState call inside an effect body required.
//
// localStorage isn't reactive on its own: the browser only fires "storage"
// in OTHER tabs, never the tab that made the write. So cycle() below also
// dispatches this custom event to notify React in THIS tab that the snapshot
// changed (the standard workaround for useSyncExternalStore + localStorage).
// Both listeners are defined at module scope so they're stable references —
// required for useSyncExternalStore to avoid re-subscribing every render.
// ---------------------------------------------------------------------------
const CHOICE_CHANGED_EVENT = "wasabi-theme-changed";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHOICE_CHANGED_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHOICE_CHANGED_EVENT, onStoreChange);
  };
}

function getServerSnapshot(): Choice {
  return "system";
}

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readStored, getServerSnapshot);

  // Reflect the resolved choice onto <html data-theme>. Fires after every
  // commit where `choice` changed — covers the post-hydration swap (server's
  // "system" -> the real stored choice) and a change made in another tab.
  // cycle() below also applies synchronously on click for instant feedback;
  // this effect is what keeps <html> in sync when something OTHER than this
  // component's own click changed the choice. (A DOM mutation, not a
  // setState call, so react-hooks/set-state-in-effect doesn't apply to it.)
  useEffect(() => {
    apply(choice);
  }, [choice]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* persistence best-effort; the attribute is already applied. */
    }
    // Same-tab notification — see the plumbing comment above.
    window.dispatchEvent(new Event(CHOICE_CHANGED_EVENT));
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${NAME[choice]}. Activate to change.`}
      title={`Theme — ${NAME[choice]}`}
      className="inline-flex items-center justify-center rounded-md border border-line bg-surface px-2 py-1 font-mono text-sm leading-none text-faint transition-colors duration-[120ms] ease-smooth hover:border-line-strong hover:text-accent"
    >
      <span aria-hidden="true">{GLYPH[choice]}</span>
      <span className="sr-only">{NAME[choice]} theme</span>
    </button>
  );
}
