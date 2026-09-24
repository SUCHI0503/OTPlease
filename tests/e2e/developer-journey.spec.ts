import { expect, test } from "@playwright/test";
import { verifyWebhook } from "../../apps/server/src/lib/webhook-signature";
import { api, asAdmin, asInspector, cardValue, env, loginViaDemo, signInToDashboard, startReceiver, uniquePhone } from "./support";

test.describe.configure({ mode: "serial" });

test.describe("a developer using the dashboard", () => {
  test("is kept out without the admin token, and signing in and out works", async ({ page, browser, context }) => {
    // A stranger is sent to the sign-in page
    const stranger = await browser.newContext();
    const sp = await stranger.newPage();
    await sp.goto(env().dashboard);
    await expect(sp).toHaveURL(/\/login$/);
    await stranger.close();

    await page.goto(`${env().dashboard}/login`);
    await page.getByLabel("Admin token").fill("this-is-not-the-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("p.error")).toContainText("not accepted");
    expect((await context.cookies()).some((c) => c.name === "otp_admin")).toBe(false);

    await signInToDashboard(page);
    const cookie = (await context.cookies()).find((c) => c.name === "otp_admin")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(await page.evaluate(() => document.cookie)).not.toContain("otp_admin");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto(env().dashboard);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("creates an application and an API key, uses the key, and revoking it stops it at once", async ({ page }) => {
    await signInToDashboard(page);
    const name = `E2E App ${Date.now()}`;
    await page.getByLabel("Application name").fill(name);
    await page.getByRole("button", { name: "Create application" }).click();
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const appId = page.url().match(/\/apps\/([0-9a-f-]{36})/)![1]!;

    await page.getByLabel("Key name").fill("backend");
    await page.getByLabel("otp:request", { exact: true }).check();
    await page.getByRole("button", { name: "Create API key" }).click();
    const key = (await page.locator(".secret code").innerText()).trim();
    expect(key).toMatch(/^otpl_[0-9a-f]{12}_/);

    // The secret is shown once: a reload no longer has it
    await page.reload();
    await expect(page.locator(".secret")).toHaveCount(0);
    expect(await page.content()).not.toContain(key);

    // The key really works against the API, but only for its own application and its own scope
    const asKey = { "x-api-key": key };
    const otp = (id: string) => api(`/applications/${id}/otp/request`, { method: "POST", headers: asKey, body: { phone: uniquePhone() } });
    expect((await otp(appId)).status).toBe(202);
    expect((await otp(env().appId)).status).toBe(403); // someone else's application
    expect((await api(`/applications/${appId}/users`, { headers: asKey })).status).toBe(403); // not in its scopes

    // Revoke in the dashboard: it stops working immediately
    await page.getByRole("button", { name: "Revoke key backend" }).click();
    await expect(page.getByText("No active keys")).toBeVisible();
    expect((await otp(appId)).status).toBe(401);

    // The audit trail shows who did it, with no secret in it
    const audit = await api(`/applications/${appId}/audit-logs`, { headers: asAdmin() });
    const actions = (audit.json as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["application.created", "api_key.created", "api_key.revoked"]));
    expect(JSON.stringify(audit.json)).not.toContain(key.slice(18));
  });

  test("sees usage change after a real user signs in", async ({ page, context }) => {
    await signInToDashboard(page);
    await page.goto(`${env().dashboard}/apps/${env().appId}`);
    const before = {
      requests: await cardValue(page, "OTP requests"),
      logins: await cardValue(page, "Logins"),
      users: await cardValue(page, "Users"),
      devices: await cardValue(page, "New devices"),
    };

    const visitor = await context.browser()!.newContext();
    const vp = await visitor.newPage();
    await loginViaDemo(vp, uniquePhone());
    await visitor.close();

    await page.reload();
    expect(await cardValue(page, "OTP requests")).toBe(before.requests + 1);
    expect(await cardValue(page, "Logins")).toBe(before.logins + 1);
    expect(await cardValue(page, "Users")).toBe(before.users + 1);
    expect(await cardValue(page, "New devices")).toBe(before.devices + 1);
  });

  test("adds a webhook and its receiver can verify signatures and reject replays", async ({ page, browser }) => {
    const receiver = await startReceiver();
    try {
      await signInToDashboard(page);
      await page.goto(`${env().dashboard}/apps/${env().appId}`);
      await page.getByLabel("Endpoint URL").fill(receiver.url);
      for (const event of ["otp.verified", "delivery.sent", "device.new"]) await page.getByLabel(event, { exact: true }).check();
      await page.getByRole("button", { name: "Add webhook" }).click();
      const secret = (await page.locator(".secret code").innerText()).trim();
      expect(secret).toMatch(/^whsec_/);

      const phone = uniquePhone();
      const visitor = await browser.newContext();
      const code = await loginViaDemo(await visitor.newPage(), phone);
      await visitor.close();

      await expect.poll(() => receiver.received.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

      const events = receiver.received.map((r) => ({ ...r, event: JSON.parse(r.body) as { id: string; type: string; data: Record<string, unknown> } }));
      expect(events.map((e) => e.event.type).sort()).toEqual(["delivery.sent", "device.new", "otp.verified"]);

      for (const e of events) {
        // Every delivery is genuinely signed by the secret shown in the dashboard
        expect(verifyWebhook({ secret, body: e.body, timestamp: e.headers["x-otplease-timestamp"] as string, signature: e.headers["x-otplease-signature"] as string })).toEqual({ ok: true });
        expect(e.headers["x-otplease-event-id"]).toBe(e.event.id);
        // and carries neither the code nor the phone number
        expect(e.body).not.toContain(code);
        expect(e.body).not.toContain(phone.slice(3));
      }

      // A different secret does not verify, and a captured request replayed an hour later is refused
      const first = events[0]!;
      const headers = { timestamp: first.headers["x-otplease-timestamp"] as string, signature: first.headers["x-otplease-signature"] as string };
      expect(verifyWebhook({ secret: "whsec_not-the-secret", body: first.body, ...headers }).ok).toBe(false);
      expect(verifyWebhook({ secret, body: first.body, ...headers, nowSeconds: Math.floor(Date.now() / 1000) + 3600 })).toEqual({ ok: false, reason: "expired" });

      // Tidy up in the dashboard, and the audit log recorded who added it without the secret
      await page.getByRole("button", { name: /Remove webhook/ }).click();
      await expect(page.getByText("No webhook endpoints.")).toBeVisible();
      const audit = await api(`/applications/${env().appId}/audit-logs`, { headers: asInspector() });
      expect(JSON.stringify(audit.json)).toContain("webhook.created");
      expect(JSON.stringify(audit.json)).not.toContain(secret);
    } finally {
      await receiver.close();
    }
  });

  test("private and internal webhook addresses are refused in the dashboard", async ({ page }) => {
    await signInToDashboard(page);
    await page.goto(`${env().dashboard}/apps/${env().appId}`);
    // The E2E stack allows localhost so receivers work, but never non-http(s) schemes or embedded credentials
    for (const [url, message] of [["ftp://example.com/hook", "https"], ["https://user:pw@example.com/hook", "credentials"]] as const) {
      await page.getByLabel("Endpoint URL").fill(url);
      await page.getByLabel("delivery.sent", { exact: true }).check();
      await page.getByRole("button", { name: "Add webhook" }).click();
      await expect(page.locator("p.error")).toContainText(message);
      await page.reload();
    }
  });
});
