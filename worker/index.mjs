import { handleAuthRequest, requireAccess } from "./auth/index.mjs";

const publicFiles = new Set(["/login.html", "/login.js", "/login.css"]);

function json(value, status = 200) {
  return Response.json(value, { status });
}

function secure(response, request) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return json({ error: "Invalid path" }, 400);
  }
  if (
    /[\u0000-\u001f\\]/u.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".")
  )
    return json({ error: "Invalid path" }, 400);
  const reading = ["GET", "HEAD"].includes(request.method);
  if (reading && path === "/healthz") {
    return json(
      { status: env.ASSETS && env.AUTH_DB ? "ready" : "unavailable" },
      env.ASSETS && env.AUTH_DB ? 200 : 503,
    );
  }
  if (reading && (path === "/login" || publicFiles.has(path))) {
    url.pathname = path === "/login" ? "/login.html" : path;
    return env.ASSETS.fetch(new Request(url, request));
  }
  const authResponse = await handleAuthRequest(request, env);
  if (authResponse) return authResponse;
  const access = await requireAccess(request, env);
  if (access.response) {
    if (reading && path === "/" && access.response.status === 401) {
      return new Response(null, {
        status: 303,
        headers: {
          Location:
            "/login?next=" + encodeURIComponent(url.pathname + url.search),
        },
      });
    }
    return access.response;
  }
  if (!reading) return json({ error: "Method not allowed" }, 405);
  if (path.startsWith("/api/") || path.startsWith("/auth/"))
    return json({ error: "Not found" }, 404);
  if (path === "/") url.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(url, request));
}

export default {
  async fetch(request, env) {
    try {
      return secure(await route(request, env), request);
    } catch {
      return secure(
        json({ error: "The service is temporarily unavailable" }, 503),
        request,
      );
    }
  },
};
