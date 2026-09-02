"use client";

// The /ledger reference view. Renders the static VWO back-catalogue
// (lib/ledger-data.ts) with a brand + verdict filter. Client component only for
// the filter state; the data is a compile-time constant, so there is no fetch.
import { useMemo, useState } from "react";
import {
  EXPERIMENTS,
  LEDGER_GROUPS,
  VERDICT_LABEL,
  type Experiment,
  type Verdict,
  type Brand,
} from "@/lib/ledger-data";

const BRANDS: Brand[] = ["AC", "TU", "PDF", "AS"];
const VERDICTS: Verdict[] = ["win", "flat", "loss", "nodata"];

const STRIPE: Record<Verdict, string> = {
  win: "border-l-good",
  loss: "border-l-bad",
  flat: "border-l-faint",
  nodata: "border-l-warn",
};
const PILL: Record<Verdict, string> = {
  win: "bg-good/12 text-good",
  loss: "bg-bad/12 text-bad",
  flat: "bg-surface-hover text-muted",
  nodata: "bg-warn/12 text-warn",
};

function liftClass(lift: number): string {
  if (lift > 0.5) return "text-good";
  if (lift < -0.5) return "text-bad";
  return "text-muted";
}
function liftText(x: Experiment): string {
  if (!x.n || x.best === "—" || x.verdict === "nodata") return "—";
  if (x.lift === 0) return "±0%";
  return `${x.lift > 0 ? "+" : ""}${x.lift}%`;
}
function flagIsBad(f: string): boolean {
  return /broken|starved|artifact|goal changed|no traffic|tiny|near-zero|worse|negative|0 conv/i.test(
    f,
  );
}

function Card({ x }: { x: Experiment }) {
  return (
    <article
      className={`flex flex-col gap-2.5 rounded-xl border border-line ${STRIPE[x.verdict]} border-l-[3px] bg-surface p-4`}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div>
          <div className="font-mono text-[11px] text-faint">
            #{x.id} · {x.type}
          </div>
          <h3 className="mt-0.5 font-display text-[15px] font-semibold leading-tight tracking-tight text-fg">
            {x.name}
          </h3>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${PILL[x.verdict]}`}
        >
          {VERDICT_LABEL[x.verdict]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-accent/12 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-accent">
          {x.brand}
        </span>
        {x.live && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-good">
            <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
            running
          </span>
        )}
      </div>

      <Kv k="Page" v={x.page} />
      <Kv k="What changed" v={x.element} />
      <Kv k="Arms" v={x.variants} muted />

      <div className="rounded-lg bg-bg-elevated p-3 text-[13px]">
        <div className="mb-1.5 font-mono text-[11px] tracking-wide text-faint">
          {x.goal}
        </div>
        {x.n && x.best !== "—" ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono tabular-nums text-fg">{x.ctrl}</span>
            <span className="text-faint">→</span>
            <span className="font-mono tabular-nums text-fg">{x.best}</span>
            <span className={`font-mono text-[13px] font-semibold ${liftClass(x.lift)}`}>
              {liftText(x)}
            </span>
            <span className="font-mono text-[11.5px] text-faint">
              {x.prob}% p · n={x.n.toLocaleString()} · {x.days}d
            </span>
          </div>
        ) : (
          <div className="font-mono text-[12px] text-faint">
            no usable result · n={(x.n || 0).toLocaleString()} · {x.days}d
          </div>
        )}
      </div>

      {x.flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {x.flags.map((f) => (
            <span
              key={f}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                flagIsBad(f)
                  ? "border-bad/40 text-bad"
                  : "border-line text-muted"
              }`}
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function Kv({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="text-[13px]">
      <span className="font-mono text-[11px] uppercase tracking-wide text-faint">
        {k}
      </span>
      <div className={`mt-0.5 ${muted ? "text-muted" : "text-fg"}`}>{v}</div>
    </div>
  );
}

function Chip({
  label,
  active,
  tone,
  onClick,
}: {
  label: string;
  active: boolean;
  tone?: "good" | "bad";
  onClick: () => void;
}) {
  const on =
    tone === "good"
      ? "border-good bg-good/12 text-fg"
      : tone === "bad"
        ? "border-bad bg-bad/12 text-fg"
        : "border-accent bg-accent/12 text-fg";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
        active ? on : "border-line bg-surface text-muted hover:border-accent hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

export function LedgerView() {
  const [brands, setBrands] = useState<Set<Brand>>(new Set());
  const [verdicts, setVerdicts] = useState<Set<Verdict>>(new Set());

  const toggle = <T,>(set: Set<T>, setter: (s: Set<T>) => void, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };

  const shown = useMemo(
    () =>
      EXPERIMENTS.filter(
        (x) =>
          (brands.size === 0 || brands.has(x.brand)) &&
          (verdicts.size === 0 || verdicts.has(x.verdict)),
      ),
    [brands, verdicts],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-faint">
          Brand
        </span>
        {BRANDS.map((b) => (
          <Chip
            key={b}
            label={b}
            active={brands.has(b)}
            onClick={() => toggle(brands, setBrands, b)}
          />
        ))}
        <span className="ml-2 font-mono text-[11px] uppercase tracking-widest text-faint">
          Verdict
        </span>
        {VERDICTS.map((v) => (
          <Chip
            key={v}
            label={VERDICT_LABEL[v]}
            active={verdicts.has(v)}
            tone={v === "win" ? "good" : v === "loss" ? "bad" : undefined}
            onClick={() => toggle(verdicts, setVerdicts, v)}
          />
        ))}
        {(brands.size > 0 || verdicts.size > 0) && (
          <button
            type="button"
            onClick={() => {
              setBrands(new Set());
              setVerdicts(new Set());
            }}
            className="ml-auto rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-accent hover:text-fg"
          >
            Reset
          </button>
        )}
      </div>

      {LEDGER_GROUPS.map((g) => {
        const items = shown.filter((x) => x.group === g.key);
        if (items.length === 0) return null;
        return (
          <section key={g.key} className="mt-8">
            <h2 className="font-display text-base font-bold tracking-tight text-fg">
              {g.title}{" "}
              <span className="font-mono text-[13px] font-normal text-faint">
                · {items.length}
              </span>
            </h2>
            <p className="mb-4 mt-1 max-w-[74ch] text-[13.5px] text-muted">
              {g.desc}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3.5">
              {items.map((x) => (
                <Card key={x.id} x={x} />
              ))}
            </div>
          </section>
        );
      })}

      {shown.length === 0 && (
        <p className="py-10 text-center font-mono text-sm text-faint">
          Nothing matches those filters.
        </p>
      )}
    </div>
  );
}
