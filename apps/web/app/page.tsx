import Link from "next/link";
import { CreateApplicationForm } from "@/components/forms";
import { loadOrLogin } from "@/lib/api";
import type { Overview } from "@/lib/types";

export default async function Home() {
  const result = await loadOrLogin<Overview>("/analytics/overview?days=7");
  if (!result.ok) return <p className="error" role="alert">{result.message}</p>;
  const { totals, applications } = result.data;

  return (
    <>
      <h1>Applications</h1>
      <p className="muted">Activity over the last 7 days.</p>

      <div className="cards">
        <div className="card"><span className="label">Applications</span><span className="value">{totals.applications}</span></div>
        <div className="card"><span className="label">OTP requests</span><span className="value">{totals.otpRequests}</span></div>
        <div className="card"><span className="label">Logins</span><span className="value">{totals.logins}</span></div>
      </div>

      <section>
        <h2>Create an application</h2>
        <CreateApplicationForm />
      </section>

      <section>
        <h2>All applications</h2>
        {applications.length === 0 ? (
          <p className="muted">No applications yet. Create your first one above.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th className="num">OTP requests</th><th className="num">Logins</th><th>Created</th></tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td><Link href={`/apps/${a.id}`}>{a.name}</Link></td>
                    <td className="num">{a.otpRequests}</td>
                    <td className="num">{a.logins}</td>
                    <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
