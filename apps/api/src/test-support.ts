import { hashToken } from "./auth/tokens.js";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store/memory.js";

/** Users and tokens for route tests; workspaces are created through the API. */
export const people = {
  olivia: { id: "usr_olivia", email: "olivia@example.test", displayName: "Olivia", token: "stk_test_olivia" },
  marco: { id: "usr_marco", email: "marco@example.test", displayName: "Marco", token: "stk_test_marco" },
  vera: { id: "usr_vera", email: "vera@example.test", displayName: "Vera", token: "stk_test_vera" },
  gabe: { id: "usr_gabe", email: "gabe@example.test", displayName: "Gabe", token: "stk_test_gabe" },
} as const;

export type Person = keyof typeof people;

export function setup() {
  const store = new MemoryStore();
  for (const { token, ...user } of Object.values(people)) store.addUser(user, hashToken(token));
  const app = buildServer({ logger: false, store });

  const call = (who: Person | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: who === null ? {} : { authorization: `Bearer ${people[who].token}` },
    });

  /**
   * Two workspaces: "acme" (olivia owner, marco maintainer, vera viewer) and
   * "globex" (gabe owner). Each has one connected repository.
   */
  async function twoWorkspaces() {
    const acme = (await call("olivia", "POST", "/v1/workspaces", { name: "Acme" })).json().data.id as string;
    const globex = (await call("gabe", "POST", "/v1/workspaces", { name: "Globex" })).json().data.id as string;
    await call("olivia", "POST", `/v1/workspaces/${acme}/members`, { email: people.marco.email, role: "maintainer" });
    await call("olivia", "POST", `/v1/workspaces/${acme}/members`, { email: people.vera.email, role: "viewer" });
    const acmeRepo = (
      await call("olivia", "POST", `/v1/workspaces/${acme}/repositories`, { owner: "acme-demo", name: "checkout" })
    ).json().data.id as string;
    const globexRepo = (
      await call("gabe", "POST", `/v1/workspaces/${globex}/repositories`, { owner: "globex", name: "payments" })
    ).json().data.id as string;
    return { acme, globex, acmeRepo, globexRepo };
  }

  return { app, store, call, twoWorkspaces };
}
