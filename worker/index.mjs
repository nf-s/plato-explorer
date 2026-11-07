import { handleAuthRequest, requireAccess } from "./auth/index.mjs";

const publicFiles = new Set(["/login.html", "/login.js", "/login.css"]);

function json(value, status = 200) {
  return Response.json(value, { status });
}

async function secure(response, request) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  let body = request.method === "HEAD" ? null : response.body;
  // Pages injects its own beacon. Never add the private site's token to shared assets.
  if (
    request.method === "GET" &&
    new URL(request.url).hostname === "plato-explorer.nf-s.workers.dev" &&
    response.status === 200 &&
    response.headers.get("Content-Type")?.split(";")[0].trim() === "text/html"
  ) {
    const html = await response.text();
    const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"830982296f06491d8f8d4205079e2c48"}'></script>`;
    body = html.includes("static.cloudflareinsights.com/beacon.min.js")
      ? html
      : html.replace("</body>", `${beacon}</body>`);
    headers.delete("Content-Length");
  }
  return new Response(body, {
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
      return await secure(await route(request, env), request);
    } catch {
      return secure(
        json({ error: "The service is temporarily unavailable" }, 503),
        request,
      );
    }
  },
};
