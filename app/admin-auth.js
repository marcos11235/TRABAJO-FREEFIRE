const crypto = require("node:crypto");

const ADMIN_SESSION_COOKIE = "vertice_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

function isAdminAuthConfigured(env = process.env) {
  return typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= 12 &&
    typeof env.ADMIN_SESSION_SECRET === "string" && Buffer.byteLength(env.ADMIN_SESSION_SECRET) >= 32;
}

function verifyAdminCredentials(username, password, env = process.env) {
  if (!isAdminAuthConfigured(env) || typeof username !== "string" || typeof password !== "string") return false;
  const suppliedUsername = Buffer.from(username.trim().toLowerCase());
  const expectedUsername = Buffer.from("admin");
  const suppliedPassword = Buffer.from(password);
  const expectedPassword = Buffer.from(env.ADMIN_PASSWORD);
  return suppliedUsername.length === expectedUsername.length &&
    suppliedPassword.length === expectedPassword.length &&
    crypto.timingSafeEqual(suppliedUsername, expectedUsername) &&
    crypto.timingSafeEqual(suppliedPassword, expectedPassword);
}

function createAdminSessionCookie(request, env = process.env, now = Date.now()) {
  if (!isAdminAuthConfigured(env)) throw new Error("Configura ADMIN_PASSWORD y ADMIN_SESSION_SECRET en el servidor.");
  const expiresAt = Math.floor(now / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const signature = crypto.createHmac("sha256", env.ADMIN_SESSION_SECRET)
    .update(String(expiresAt))
    .digest("base64url");
  const secure = request.headers["x-forwarded-proto"] === "https" || Boolean(request.socket?.encrypted);
  return `${ADMIN_SESSION_COOKIE}=${expiresAt}.${signature}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

function clearAdminSessionCookie(request) {
  const secure = request.headers["x-forwarded-proto"] === "https" || Boolean(request.socket?.encrypted);
  return `${ADMIN_SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function hasValidAdminSession(request, env = process.env, now = Date.now()) {
  if (!isAdminAuthConfigured(env)) return false;
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map(part => part.trim())
    .find(part => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  const value = cookie?.slice(ADMIN_SESSION_COOKIE.length + 1) || "";
  const match = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + ADMIN_SESSION_TTL_SECONDS) return false;
  const expected = crypto.createHmac("sha256", env.ADMIN_SESSION_SECRET)
    .update(match[1])
    .digest();
  const supplied = Buffer.from(match[2], "base64url");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasValidAdminSession,
  isAdminAuthConfigured,
  verifyAdminCredentials
};
