import { ErrorIcon } from "./icon";

/** The display filter, and an echo of an invalid one with carets under its bad token: no overlay to align. */
export function PacketFilterBar({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: { message: string; start: number; end: number } | null;
}) {
  return (
    <div className="filter-bar">
      <input
        data-testid="packet-filter-input"
        className="text-input mono"
        placeholder="Filter, e.g. tcp.port == 443 && ip.addr == 10.0.0.5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error !== null}
        aria-label="Packet display filter"
      />
      {error && (
        <div className="filter-error">
          <pre data-testid="packet-filter-mark">
            {`${value}\n${" ".repeat(error.start)}${"^".repeat(Math.max(1, error.end - error.start))}`}
          </pre>
          <p className="filter-error-message">
            <ErrorIcon />
            <span data-testid="packet-filter-error">{error.message}</span>
          </p>
        </div>
      )}
    </div>
  );
}
