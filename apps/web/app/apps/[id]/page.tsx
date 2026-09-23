import Link from "next/link";
import { notFound } from "next/navigation";
import { revokeApiKey, revokeWebhook } from "@/app/actions";
import { CreateKeyForm, CreateWebhookForm } from "@/components/forms";
import { DailyChart } from "@/components/daily-chart";
import { loadOrLogin } from "@/lib/api";
import type { Analytics, ApiKeyRow, WebhookRow } from "@/lib/types";

const RANGES = [7, 14, 30];

export default async function ApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { id } = await params;
  const requested = Number((await searchParams).days);
  const days = RANGES.includes(requested) ? requested : 7;

  const [app, stats, keys, hooks] = await Promise.all([
    loadOrLogin<{ id: string; name: string }>(`/applications/${id}`),
    loadOrLogin<Analytics>(`/applications/${id}/analytics?days=${days}`),
    loadOrLogin<ApiKeyRow[]>(`/applications/${id}/api-keys`),
    loadOrLogin<WebhookRow[]>(`/applications/${id}/webhooks`),
  ]);

  if (!app.ok && (app.status === 404 || app.status === 400)) notFound();
  if (!app.ok) return <p className="error" role="alert">{app.message}</p>;
  if (!stats.ok || !keys.ok || !hooks.ok) {
    const failed = [stats, keys, hooks].find((r) => !r.ok);
    return <p className="error" role="alert">{failed && !failed.ok ? failed.message : "Something went wrong"}</p>;
  }

  const t = stats.data.totals;
  const rate = t.deliverySuccessRate === null ? "n/a" : `${Math.round(t.deliverySuccessRate * 1000) / 10}%`;
  const activeKeys = keys.data.filter((k) => !k.revokedAt);
  const activeHooks = hooks.data.filter((h) => !h.revokedAt);

  return (
    <>
      <p><Link href="/">← All applications</Link></p>
      <h1>{app.data.name}</h1>
      <p className="muted mono">{app.data.id}</p>

      <nav className="range" aria-label="Time range">
        {RANGES.map((r) => (
          <Link key={r} href={`?days=${r}`} aria-current={r === days ? "true" : undefined}>{r} days</Link>
        ))}
      </nav>

      <div className="cards">
        <div className="card"><span className="label">OTP requests</span><span className="value">{t.otpRequests}</span></div>
        <div className="card"><span className="label">Delivery success</span><span className="value">{rate}</span></div>
        <div className="card"><span className="label">Logins</span><span className="value">{t.logins}</span></div>
        <div className="card"><span className="label">Active sessions</span><span className="value">{t.activeSessions}</span></div>
        <div className="card"><span className="label">Users</span><span className="value">{t.users}</span></div>
        <div className="card"><span className="label">Failed deliveries</span><span className="value">{t.deliveriesFailed}</span></div>
      </div>

      <section>
        <h2>Daily activity</h2>
        <DailyChart daily={stats.data.daily} />
      </section>

      <section>
        <h2>By channel</h2>
        {stats.data.byChannel.length === 0 ? (
          <p className="muted">No messages in this period.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Channel</th><th className="num">Requests</th><th className="num">Failed</th></tr></thead>
              <tbody>
                {stats.data.byChannel.map((c) => (
                  <tr key={c.channel}><td>{c.channel}</td><td className="num">{c.requests}</td><td className="num">{c.failed}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>API keys</h2>
        {activeKeys.length === 0 ? (
          <p className="muted">No active keys. Create one so your backend can call the API.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {activeKeys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono">otpl_{k.prefix}…</td>
                    <td>{k.scopes.join(", ")}</td>
                    <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
                    <td>
                      <form action={revokeApiKey}>
                        <input type="hidden" name="applicationId" value={id} />
                        <input type="hidden" name="keyId" value={k.id} />
                        <button className="danger" aria-label={`Revoke key ${k.name}`}>Revoke</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>New API key</h3>
        <CreateKeyForm applicationId={id} />
      </section>

      <section>
        <h2>Webhooks</h2>
        <p className="muted">{t.webhookFailures} failed webhook deliveries in this period.</p>
        {activeHooks.length === 0 ? (
          <p className="muted">No webhook endpoints.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>URL</th><th>Events</th><th /></tr></thead>
              <tbody>
                {activeHooks.map((h) => (
                  <tr key={h.id}>
                    <td className="mono">{h.url}</td>
                    <td>{h.events.join(", ")}</td>
                    <td>
                      <form action={revokeWebhook}>
                        <input type="hidden" name="applicationId" value={id} />
                        <input type="hidden" name="webhookId" value={h.id} />
                        <button className="danger" aria-label={`Remove webhook ${h.url}`}>Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>New webhook</h3>
        <CreateWebhookForm applicationId={id} />
      </section>
    </>
  );
}
