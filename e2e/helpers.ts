import { expect, type Page } from "@playwright/test";

export const ADMIN_PASSWORD = "e2e-support"; // = playwright.config.ts
export const unique = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The low-balance modal can open at any moment (alerts): dismiss it with "Not now". */
export async function autoDismissLowBalance(page: Page) {
  await page.addLocatorHandler(page.getByRole("dialog", { name: /balance/i }), async d => { await d.getByRole("button", { name: "Not now" }).click(); });
}

export async function me(page: Page) {
  const r = await page.request.get("/api/me");
  expect(r.ok()).toBeTruthy();
  return r.json() as Promise<{ customerId: string; balance: number; spent: number; blocked: boolean; plan: string; email: string; spendCap?: { monthlyEur: number } }>;
}

/** Simulated sign-up through the API (for tests that are not about the sign-up flow). */
export async function signupViaApi(page: Page, plan: "free" | "pro" | "scale" = "pro") {
  const email = `${unique("a11y")}@example.com`;
  const r = await page.request.post("/api/signup", { data: { name: "A11y Tester", email, plan } });
  expect(r.ok()).toBeTruthy();
  return email;
}
