const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const handleRequest = require("../app/server");
const {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasValidAdminSession,
  isAdminAuthConfigured,
  verifyAdminCredentials
} = require("../app/admin-auth");

const env = {
  ADMIN_PASSWORD: "private-admin-password",
  ADMIN_SESSION_SECRET: Buffer.alloc(32, 9).toString("base64url")
};
const now = Date.UTC(2026, 9, 16, 12);

function request(cookie = "", secure = true) {
  return {
    headers: {
      cookie,
      "x-forwarded-proto": secure ? "https" : "http"
    },
    socket: {}
  };
}

test("requires a configured password and signing secret for admin auth", () => {
  assert.equal(isAdminAuthConfigured(env), true);
  assert.equal(isAdminAuthConfigured({ ...env, ADMIN_PASSWORD: "short" }), false);
  assert.equal(isAdminAuthConfigured({ ...env, ADMIN_SESSION_SECRET: "short" }), false);
});

test("verifies the admin username and password", () => {
  assert.equal(verifyAdminCredentials("ADMIN", env.ADMIN_PASSWORD, env), true);
  assert.equal(verifyAdminCredentials("admin", "wrong-password", env), false);
  assert.equal(verifyAdminCredentials("customer", env.ADMIN_PASSWORD, env), false);
});

test("signs an expiring HttpOnly admin session cookie", () => {
  const cookie = createAdminSessionCookie(request(), env, now);
  const cookiePair = cookie.split(";", 1)[0];
  const authenticatedRequest = request(cookiePair);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  assert.equal(hasValidAdminSession(authenticatedRequest, env, now), true);
  assert.equal(hasValidAdminSession(authenticatedRequest, env, now + 8 * 60 * 60 * 1000), false);
  assert.equal(hasValidAdminSession(request(`${cookiePair}tampered`), env, now), false);
  assert.match(clearAdminSessionCookie(request()), /Max-Age=0/);
});

test("admin session API logs in, authorizes requests, and logs out", async () => {
  const previousPassword = process.env.ADMIN_PASSWORD;
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_PASSWORD = env.ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = env.ADMIN_SESSION_SECRET;
  const server = http.createServer(handleRequest);

  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const deniedImport = await fetch(`${baseUrl}/api/admin/pines/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(deniedImport.status, 401);

    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: env.ADMIN_PASSWORD })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];

    const session = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: cookie }
    });
    assert.deepEqual(await session.json(), { authenticated: true });

    const logout = await fetch(`${baseUrl}/api/admin/session`, {
      method: "DELETE",
      headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 200);
    const expiredCookie = logout.headers.get("set-cookie").split(";", 1)[0];
    const afterLogout = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: expiredCookie }
    });
    assert.deepEqual(await afterLogout.json(), { authenticated: false });
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
});
