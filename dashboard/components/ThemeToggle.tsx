"use client";

// Three-state theme control: system → light → dark → system. "System" follows
// the device's prefers-color-scheme (the default); "light"/"dark" force a theme
// via a data-theme attribute on <html> that wins over the OS. The choice is
// persisted in localStorage and re-applied on load by an inline no-flash script
// in app/layout.tsx, so this component only keeps the glyph in sync and writes
// the next choice. Unicode affordance glyphs (no emoji), matching the cockpit.
import { useEffect, useState } from "react";

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

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");
  // Server and first client render both show the neutral state, so hydration
  // matches; the real choice lands after mount.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = readStored();
    setChoice(stored);
    apply(stored);
    setMounted(true);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    setChoice(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* persistence best-effort; the attribute is already applied. */
    }
  }

  const label = mounted ? NAME[choice] : "System";

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={
        mounted ? `Theme: ${label}. Activate to change.` : "Change theme"
      }
      title={`Theme — ${label}`}
      className="inline-flex items-center justify-center rounded-md border border-line bg-surface px-2 py-1 font-mono text-sm leading-none text-faint transition-colors duration-[120ms] ease-smooth hover:border-line-strong hover:text-accent"
    >
      <span aria-hidden="true">{mounted ? GLYPH[choice] : GLYPH.system}</span>
      <span className="sr-only">{label} theme</span>
    </button>
  );
}
