import { element } from "./data-model.js";

// The page can read this cookie, which is set with every session. A browser
// without it has no session, so the app asks for none.
const SESSION_MARKER = "__Host-plato-csrf";
// The local preview has no account service and shows every built realm.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// A failed sign-in returns to the app with its reason in this parameter.
const FAILURE_PARAMETER = "signin";

const FAILURES = {
  access_denied:
    "This account does not have access. Ask the administrator to add your email address.",
  authentication_required: "Sign in to continue.",
  enrollment_required:
    "This account needs the administrator to approve its Google account ID before it can sign in.",
  invalid_state: "This sign-in attempt expired. Try again.",
  invalid_request: "This sign-in attempt could not be completed. Try again.",
  login_cancelled: "Sign-in was cancelled.",
  invalid_identity:
    "This Google account could not be verified. Try another account.",
  configuration_error: "Sign-in is not configured yet.",
  storage_unavailable: "Sign-in is temporarily unavailable. Try again later.",
  google_unavailable:
    "Google sign-in is temporarily unavailable. Try again later.",
  authentication_unavailable:
    "Sign-in is temporarily unavailable. Try again later.",
};

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasSessionMarker(cookie) {
  return cookie
    .split(";")
    .some((part) => part.trim().startsWith(`${SESSION_MARKER}=`));
}

export function validateSession(data) {
  if (record(data) && data.authenticated === false)
    return { kind: "anonymous" };
  if (
    !record(data) ||
    data.authenticated !== true ||
    typeof data.email !== "string" ||
    !data.email ||
    data.email.length > 254 ||
    typeof data.isAdmin !== "boolean" ||
    (data.csrfToken !== null &&
      (typeof data.csrfToken !== "string" || !data.csrfToken))
  )
    throw new Error("The account session returned an invalid response.");
  return {
    kind: "signed-in",
    email: data.email,
    isAdmin: data.isAdmin,
    csrfToken: data.csrfToken,
  };
}

export function validateGrants(data) {
  if (
    !record(data) ||
    !Array.isArray(data.grants) ||
    !data.grants.every(
      (grant) =>
        record(grant) &&
        typeof grant.email === "string" &&
        grant.email.length > 0 &&
        typeof grant.enabled === "boolean" &&
        typeof grant.isAdmin === "boolean",
    )
  )
    throw new Error("The access list returned an invalid response.");
  return data.grants.map(({ email, enabled, isAdmin }) => ({
    email,
    enabled,
    isAdmin,
  }));
}

export function validateEnrollment(data, now) {
  if (!record(data)) throw new Error("Approval details could not be loaded.");
  const details = data.enrollment;
  if (details === null) return null;
  if (
    !record(details) ||
    typeof details.email !== "string" ||
    !details.email ||
    details.email.length > 254 ||
    typeof details.subject !== "string" ||
    !details.subject ||
    details.subject.length > 255 ||
    !Number.isFinite(details.expiresAt)
  )
    throw new Error("Approval details could not be verified.");
  return details.expiresAt * 1000 > now
    ? { email: details.email, subject: details.subject }
    : null;
}

// The reason a sign-in failed, or null when the address carries none.
export function signInFailure(search) {
  const code = new URLSearchParams(search).get(FAILURE_PARAMETER);
  if (code === null) return null;
  return {
    code,
    message: Object.hasOwn(FAILURES, code)
      ? FAILURES[code]
      : "Sign-in could not be completed. Try again.",
  };
}

// The address without the failure reason, so it is not kept in history.
export function withoutSignInFailure(search) {
  const parameters = new URLSearchParams(search);
  parameters.delete(FAILURE_PARAMETER);
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

// Signing in returns to the page it started from.
export function signInHref({ pathname, search, hash }) {
  const next = pathname + withoutSignInFailure(search) + hash;
  return `/auth/google/start?${new URLSearchParams({ next })}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("The account service returned an unreadable response.");
  }
}

/** Who is looking: "local", "anonymous", "unavailable" or "signed-in". */
export async function loadSession(location, cookie, request) {
  if (LOCAL_HOSTS.includes(location.hostname)) return { kind: "local" };
  if (!hasSessionMarker(cookie)) return { kind: "anonymous" };
  try {
    const response = await request("/api/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { kind: "unavailable" };
    return validateSession(await readJson(response));
  } catch {
    return { kind: "unavailable" };
  }
}

function failure(payload, status) {
  return new Error(
    record(payload) && typeof payload.message === "string"
      ? payload.message
      : status === 401
        ? "Your session expired. Sign in again to continue."
        : "The account request could not be completed.",
  );
}

async function send(session, path, method = "GET", body = null) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") {
    if (!session.csrfToken)
      throw new Error("Sign in again to restore account controls.");
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = session.csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw failure(payload, response.status);
  return payload;
}

async function confirmed(session, path, method, body) {
  const result = await send(session, path, method, body);
  if (!record(result) || result.ok !== true)
    throw new Error("The account service did not confirm the change.");
}

function button(label, className, handler) {
  const control = element("button", className, label);
  control.type = "button";
  control.addEventListener("click", handler);
  return control;
}

function dialog(title) {
  const node = element("dialog", "about-dialog account-dialog");
  node.setAttribute("aria-labelledby", "account-title");
  const heading = element("h2", "", title);
  heading.id = "account-title";
  const close = button("×", "dialog-close", () => node.close());
  close.setAttribute("aria-label", `Close ${title.toLowerCase()}`);
  node.append(close, heading);
  document.body.append(node);
  return node;
}

function signInLink(label, className) {
  const link = element("a", className, label);
  link.href = signInHref(location);
  // The address changes as the reader moves around the graph.
  link.addEventListener("click", () => {
    link.href = signInHref(location);
  });
  return link;
}

// An account outside Gmail and Google Workspace is approved by its Google
// account ID, which the reader passes to the administrator.
async function enrollmentDetails() {
  const section = element("section", "account-access");
  const status = element("p", "account-status");
  status.setAttribute("role", "status");
  section.append(status);
  try {
    const response = await fetch("/api/enrollment", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Approval details could not be loaded.");
    const details = validateEnrollment(await readJson(response), Date.now());
    if (!details) {
      status.textContent =
        "This approval request expired. Sign in again to create a new one.";
      return section;
    }
    const list = element("dl", "enrollment-details");
    const subject = element("dd");
    subject.append(element("code", "", details.subject));
    list.append(
      element("dt", "", "Email"),
      element("dd", "", details.email),
      element("dt", "", "Google account ID"),
      subject,
    );
    const copy = button("Copy details", "secondary-button", async () => {
      try {
        await navigator.clipboard.writeText(
          `Email: ${details.email}\nGoogle account ID: ${details.subject}`,
        );
        status.textContent = "Approval details copied.";
      } catch {
        status.textContent = "Select and copy the details above.";
      }
    });
    section.prepend(
      element("p", "", "Send these details to the administrator:"),
      list,
      copy,
    );
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? `${error.message} Sign in again.`
        : "Approval details could not be loaded. Sign in again.";
  }
  return section;
}

function accessManager(session) {
  const section = element("section", "account-access");
  section.append(element("h3", "", "Manage access"));
  const form = element("form", "access-form");
  const email = element("input");
  email.id = "access-email";
  email.type = "email";
  email.required = true;
  email.maxLength = 254;
  email.autocomplete = "off";
  const emailLabel = element("label", "", "Google email");
  emailLabel.htmlFor = email.id;
  const subject = element("input");
  subject.id = "access-subject";
  subject.maxLength = 255;
  subject.autocomplete = "off";
  const subjectLabel = element("label", "", "Google account ID (optional)");
  subjectLabel.htmlFor = subject.id;
  const hint = element(
    "p",
    "account-hint",
    "Gmail and Google Workspace addresses need only the email. Other addresses also need the account ID shown after their first sign-in.",
  );
  const grant = element("button", "primary-button", "Grant access");
  grant.type = "submit";
  form.append(emailLabel, email, subjectLabel, subject, hint, grant);
  const list = element("div", "access-list");
  const status = element("p", "account-status");
  status.setAttribute("role", "status");
  let busy = false;

  function setBusy(value) {
    busy = value;
    for (const control of section.querySelectorAll("input, button"))
      control.disabled = busy || !session.csrfToken;
  }

  async function refresh() {
    const grants = validateGrants(await send(session, "/api/admin/access"));
    list.replaceChildren(
      ...grants.map((item) => {
        const row = element("div", "access-row");
        const details = element("div");
        details.append(
          element("strong", "", item.email),
          element(
            "small",
            "",
            item.isAdmin
              ? "Administrator"
              : item.enabled
                ? "Allowed"
                : "Revoked",
          ),
        );
        row.append(details);
        if (!item.isAdmin)
          row.append(
            button(item.enabled ? "Revoke" : "Restore", "text-button", () =>
              change(item.enabled ? "DELETE" : "POST", { email: item.email }),
            ),
          );
        return row;
      }),
    );
  }

  async function load() {
    if (busy) return;
    setBusy(true);
    status.textContent = "Loading access list…";
    try {
      await refresh();
      status.textContent = "";
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "The access list could not be loaded.";
    } finally {
      setBusy(false);
    }
  }

  async function change(method, body) {
    if (busy) return;
    setBusy(true);
    status.textContent =
      method === "DELETE" ? "Revoking access…" : "Granting access…";
    try {
      await confirmed(session, "/api/admin/access", method, body);
      if (method === "POST") form.reset();
      await refresh();
      status.textContent = `${body.email}: ${method === "DELETE" ? "access revoked" : "access granted"}.`;
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "The access list could not be changed.";
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const identity = subject.value.trim();
    change("POST", {
      email: email.value.trim().toLowerCase(),
      ...(identity ? { subject: identity } : {}),
    });
  });
  section.append(form, list, status);
  return { section, load };
}

function signedIn(session, controls) {
  const node = dialog("Account");
  const status = element("p", "account-status");
  status.setAttribute("role", "status");
  const logout = button("Sign out", "secondary-button", async () => {
    logout.disabled = true;
    status.textContent = "Signing out…";
    try {
      await confirmed(session, "/auth/logout", "POST");
      location.replace(location.pathname);
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "Sign-out failed.";
      logout.disabled = false;
    }
  });
  logout.disabled = !session.csrfToken;
  node.append(
    element(
      "p",
      "account-email",
      session.isAdmin ? `${session.email} · Administrator` : session.email,
    ),
    logout,
    status,
  );
  if (!session.csrfToken)
    node.append(
      signInLink("Sign in again to restore account controls", "text-button"),
    );
  const access = session.isAdmin ? accessManager(session) : null;
  if (access) node.append(access.section);
  controls.append(
    button("Account", "quiet-button", () => {
      node.showModal();
      access?.load();
    }),
  );
}

async function signedOut(failed, controls) {
  controls.append(signInLink("Sign in", "quiet-button"));
  if (!failed) return;
  const node = dialog("Sign in");
  const message = element("p", "", failed.message);
  message.setAttribute("role", "alert");
  node.append(message);
  if (failed.code === "enrollment_required")
    node.append(await enrollmentDetails());
  node.append(signInLink("Sign in with Google", "primary-button"));
  node.showModal();
}

/** Adds the sign-in or account control beside About & copyright. */
export async function initAccount(session, failed) {
  const controls = document.querySelector(".account-controls");
  if (!controls || session.kind === "local") return;
  if (session.kind === "signed-in") signedIn(session, controls);
  else await signedOut(failed, controls);
}
