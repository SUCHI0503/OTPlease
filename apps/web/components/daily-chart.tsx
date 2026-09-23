import type { Analytics } from "@/lib/types";

/** Grouped bars per day, drawn as plain SVG so the page needs no chart library. */
export function DailyChart({ daily }: { daily: Analytics["daily"] }) {
  const max = Math.max(1, ...daily.flatMap((d) => [d.otpRequests, d.logins]));
  const width = 640;
  const height = 180;
  const pad = { top: 8, bottom: 22, left: 8, right: 8 };
  const slot = (width - pad.left - pad.right) / daily.length;
  const bar = Math.max(2, Math.min(18, slot / 2 - 2));
  const y = (v: number) => pad.top + (height - pad.top - pad.bottom) * (1 - v / max);
  const every = Math.ceil(daily.length / 8);
  const summary = daily.map((d) => `${d.date}: ${d.otpRequests} requests, ${d.logins} logins`).join("; ");

  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily OTP requests and logins. ${summary}`} className="chart">
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} className="axis" />
        {daily.map((d, i) => {
          const x = pad.left + i * slot + slot / 2;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${d.otpRequests} requests, ${d.logins} logins`}</title>
              <rect x={x - bar - 1} y={y(d.otpRequests)} width={bar} height={height - pad.bottom - y(d.otpRequests)} className="bar-requests" />
              <rect x={x + 1} y={y(d.logins)} width={bar} height={height - pad.bottom - y(d.logins)} className="bar-logins" />
              {i % every === 0 && (
                <text x={x} y={height - 6} textAnchor="middle" className="tick">{d.date.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="legend">
        <span><i className="swatch requests" /> OTP requests</span>
        <span><i className="swatch logins" /> Logins</span>
        <span className="muted">Peak: {max}</span>
      </figcaption>
    </figure>
  );
}
