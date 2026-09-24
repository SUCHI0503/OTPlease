import { expect, test } from "@playwright/test";
import { allCodes, api, asAdmin, asInspector, env, loginViaDemo, readCode, requestCodeInDemo, uniquePhone } from "./support";

test.describe.configure({ mode: "serial" });

test.describe("an end user signing in to a product that uses OTPlease", () => {
  test("enters a phone number, gets a code, signs in, and signing out ends the session on the server", async ({ page, context, browser }) => {
    const phone = uniquePhone();
    await loginViaDemo(page, phone);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    // The session lives in an httpOnly cookie: page scripts can never read it
    const cookie = (await context.cookies()).find((c) => c.name === "demo_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(await page.evaluate(() => document.cookie)).not.toContain("demo_session");

    // The access token is genuinely valid with OTPlease itself
    const { accessToken } = JSON.parse(decodeURIComponent(cookie.value)) as { accessToken: string };
    const bearer = { authorization: `Bearer ${accessToken}` };
    const before = await api("/auth/me", { headers: bearer });
    expect(before.status).toBe(200);
    expect(before.json.userId).toBe(await page.getByTestId("user-id").innerText());

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // Logout invalidated the session on the SERVER: the copied token is now useless
    expect((await api("/auth/me", { headers: bearer })).status).toBe(401);

    // Someone who stole the cookie before logout gets nothing from it
    const thief = await browser.newContext();
    await thief.addCookies([cookie]);
    const stolen = await thief.newPage();
    await stolen.goto(`${env().demo}/account`);
    await expect(stolen.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await thief.close();

    // and the original browser is signed out too
    await page.goto(`${env().demo}/account`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("a wrong code is refused with a clear message, and the right code then works", async ({ page }) => {
    const phone = uniquePhone();
    const since = Date.now() - 1000;
    await requestCodeInDemo(page, phone);
    const code = await readCode(phone, since);

    await page.getByLabel("Verification code").fill(code === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "wrong" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/account/);

    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/account$/);
  });

  test("a code cannot be used twice", async ({ page, browser }) => {
    const phone = uniquePhone();
    const code = await loginViaDemo(page, phone);
    await page.getByRole("button", { name: "Sign out" }).click();

    // Second browser, same phone, replaying the code that just worked
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await requestCodeInDemo(p2, phone);
    // (a fresh code was issued; the old one is dead, so using it must fail)
    const codes = await allCodes(phone);
    expect(codes.length).toBeGreaterThanOrEqual(2);
    if (codes[0] !== code) {
      await p2.getByLabel("Verification code").fill(code);
      await p2.getByRole("button", { name: "Verify" }).click();
      await expect(p2.getByRole("alert").filter({ hasText: "wrong" })).toBeVisible();
    }
    await other.close();
  });

  test("asking for a new code makes the previous one stop working", async ({ page }) => {
    const phone = uniquePhone();
    const t1 = Date.now() - 1000;
    await requestCodeInDemo(page, phone);
    const first = await readCode(phone, t1);

    await page.getByRole("button", { name: "Use a different number" }).click();
    const t2 = Date.now();
    await page.getByLabel("Phone number").fill(phone);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    const second = await readCode(phone, t2);

    if (first !== second) {
      await page.getByLabel("Verification code").fill(first);
      await page.getByRole("button", { name: "Verify" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "wrong" })).toBeVisible();
    }
    await page.getByLabel("Verification code").fill(second);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/account$/);
  });

  test("rejects a phone number that is not a phone number", async ({ page }) => {
    await page.goto(env().demo);
    await page.getByLabel("Phone number").fill("12345");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "valid phone number" })).toBeVisible();
  });

  test("someone hammering the same number is told to wait, and no extra codes are sent", async ({ page }) => {
    const phone = uniquePhone();
    for (let i = 0; i < 3; i++) await requestCodeInDemo(page, phone);
    await page.goto(env().demo);
    await page.getByLabel("Phone number").fill(phone);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Too many attempts" })).toBeVisible();
    expect((await allCodes(phone)).length).toBe(3);
  });

  test("OTPlease recognises a returning browser and notices a new one", async ({ page, browser }) => {
    const phone = uniquePhone();
    await loginViaDemo(page, phone);
    const userId = await page.getByTestId("user-id").innerText();
    await page.getByRole("button", { name: "Sign out" }).click();
    await loginViaDemo(page, phone); // same browser again
    await page.getByRole("button", { name: "Sign out" }).click();

    const devices = () => api(`/applications/${env().appId}/users/${userId}/devices`, { headers: asInspector() });
    expect((await devices()).json).toHaveLength(1); // same cookie, same device

    const other = await browser.newContext(); // a different browser profile
    const p2 = await other.newPage();
    await loginViaDemo(p2, phone);
    const list = (await devices()).json as { lastIpMasked: string | null }[];
    expect(list).toHaveLength(2);

    // Nothing raw is stored: the device id from the cookie appears nowhere in what OTPlease returns
    const deviceCookie = (await other.cookies()).find((c) => c.name === "demo_device")!;
    expect(JSON.stringify(list)).not.toContain(deviceCookie.value);
    await other.close();
  });

  test("a country the developer blocked cannot receive codes, and no message is sent", async ({ page }) => {
    const rules = `/applications/${env().appId}/risk-config`;
    const phone = uniquePhone();
    try {
      expect((await api(rules, { method: "PUT", headers: asAdmin(), body: { mode: "enforce", blockedCountries: ["IN"] } })).status).toBe(200);
      await page.goto(env().demo);
      await page.getByLabel("Phone number").fill(phone);
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "can't send a code" })).toBeVisible();
      await new Promise((r) => setTimeout(r, 1500));
      expect(await allCodes(phone)).toHaveLength(0);
    } finally {
      await api(rules, { method: "PUT", headers: asAdmin(), body: {} }); // back to the defaults
    }
    // and with the rule gone the same number works again
    await loginViaDemo(page, phone);
  });
});
