// Shared, hook-free presentational bits for the operator console tables — the
// search box, the select, the table chrome and the empty row — so the four
// panels don't each re-spell the same Signal-token classes. No "use client":
// nothing here holds state (the parent owns it), so these render in a client
// OR server component unchanged.

/** Input / select field styling — lifted verbatim from components/home so the
 *  console's filters match the rest of the tool in both themes. */
export const FIELD_CLS =
  "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none transition-colors hover:border-line-strong focus-visible:border-accent";

export const TABLE_WRAP_CLS = "overflow-x-auto rounded-xl border border-line bg-surface";
export const THEAD_ROW_CLS =
  "border-b border-line font-mono text-[11px] uppercase tracking-wider text-muted";
export const TH_CLS = "px-4 py-3 font-medium";

export function SearchBox({
  id,
  value,
  onChange,
  placeholder,
  label,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-faint"
      >
        ⌕
      </span>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-fg placeholder:text-faint outline-none transition-colors hover:border-line-strong focus-visible:border-accent"
      />
    </div>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-faint">
        {children}
      </td>
    </tr>
  );
}

/** A count chip for a filtered/total pair, e.g. "12 of 40". */
export function ResultCount({ shown, total }: { shown: number; total: number }) {
  return (
    <p className="font-mono text-[11px] text-faint">
      {shown === total ? `${total}` : `${shown} of ${total}`}
    </p>
  );
}
