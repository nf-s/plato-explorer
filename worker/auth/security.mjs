export class AuthError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class EnrollmentRequired extends AuthError {
  constructor(email, subject) {
    super(
      "An administrator must approve this Google account subject before access is granted.",
      403,
      "enrollment_required",
    );
    this.email = email;
    this.subject = subject;
  }
}

export const FLOW_SECONDS = 600;
export const SESSION_SECONDS = 8 * 60 * 60;

export function normalizeEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new AuthError("Invalid email address.");
  }
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AuthError("Invalid email address.");
  return email;
}

export function validSubject(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value);
}

export function configFromEnv(env) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "PUBLIC_URL",
    "ADMIN_EMAIL",
  ];
  for (const name of required) {
    if (typeof env[name] !== "string" || !env[name])
      throw new AuthError(
        "Google login is not configured.",
        503,
        "configuration_error",
      );
  }
  if (
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
      env.GOOGLE_CLIENT_ID,
    ) ||
    !/^[\x21-\x7e]{1,4096}$/.test(env.GOOGLE_CLIENT_SECRET)
  ) {
    throw new AuthError(
      "Google login is not configured correctly.",
      503,
      "configuration_error",
    );
  }
  let url;
  let adminEmail;
  try {
    url = new URL(env.PUBLIC_URL);
    adminEmail = normalizeEmail(env.ADMIN_EMAIL);
  } catch {
    throw new AuthError(
      "Google login is not configured correctly.",
      503,
      "configuration_error",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /[\x00-\x20\\]/.test(env.PUBLIC_URL)
  ) {
    throw new AuthError(
      "PUBLIC_URL must be an HTTPS origin.",
      503,
      "configuration_error",
    );
  }
  const adminSubject =
    env.ADMIN_SUBJECT === undefined || env.ADMIN_SUBJECT === ""
      ? null
      : env.ADMIN_SUBJECT;
  if (adminSubject !== null && !validSubject(adminSubject))
    throw new AuthError(
      "Invalid administrator configuration.",
      503,
      "configuration_error",
    );
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    publicUrl: url.origin,
    redirectUri: `${url.origin}/auth/google/callback`,
    adminEmail,
    adminSubject,
  };
}

export function safeReturnUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^[\x21-\x7e]*$/.test(value)
  )
    return "/";
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      !candidate.startsWith("/") ||
      candidate.startsWith("//") ||
      /[\x00-\x20\\]/.test(candidate)
    )
      return "/";
    const url = new URL(candidate, "https://local.invalid");
    if (
      url.origin !== "https://local.invalid" ||
      url.pathname.startsWith("/auth/")
    )
      return "/";
    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return "/";
    }
    if (decoded === candidate) return value;
    candidate = decoded;
  }
  return "/";
}

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64url(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  )
    throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
  try {
    return Uint8Array.from(
      atob(
        value.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - (value.length % 4)) % 4),
      ),
      (char) => char.charCodeAt(0),
    );
  } catch {
    throw new AuthError("Invalid Google identity.", 401, "invalid_identity");
  }
}

export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isOpaque(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function equalSecret(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  )
    return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

export async function readJson(response, maximum = 65536) {
  if (
    !response.body ||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    throw new AuthError("Invalid JSON response.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new AuthError("JSON response exceeds the supported size.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result;
  try {
    result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new AuthError("Invalid JSON response.");
  }
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new AuthError("A JSON object is required.");
  return result;
}
