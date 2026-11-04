import { element } from "./data-model.js";

function loginDestination() {
  return `/login?${new URLSearchParams({ next: location.pathname + location.search + location.hash })}`;
}

function responseError(payload, status) {
  return new Error(
    typeof payload?.message === "string"
      ? payload.message
      : status === 401
        ? "Your session expired. Sign in again to continue."
        : "The account request could not be completed.",
  );
}

function button(label, className, handler) {
  const control = element("button", className, label);
  control.type = "button";
  control.addEventListener("click", handler);
  return control;
}

export async function initAccount() {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (
    response.status === 404 &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  )
    return true;
  let session;
  try {
    session = await response.json();
  } catch {
    throw new Error("The account service returned an unreadable response.");
  }
  if (
    response.status === 401 ||
    (response.ok && session?.authenticated === false)
  ) {
    location.replace(loginDestination());
    return false;
  }
  if (!response.ok) throw responseError(session, response.status);
  if (
    !session ||
    session.authenticated !== true ||
    typeof session.email !== "string" ||
    typeof session.isAdmin !== "boolean" ||
    (session.csrfToken !== null && typeof session.csrfToken !== "string")
  )
    throw new Error("The account session returned an invalid response.");

  async function request(path, method = "GET", body = null) {
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
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The account service returned an unreadable response.");
    }
    if (!response.ok) throw responseError(payload, response.status);
    return payload;
  }

  const dialog = element("dialog", "about-dialog account-dialog");
  dialog.id = "account-dialog";
  dialog.setAttribute("aria-labelledby", "account-title");
  const title = element("h2", "", "Account");
  title.id = "account-title";
  const close = button("×", "dialog-close", () => dialog.close());
  close.setAttribute("aria-label", "Close account");
  const status = element("p", "account-status");
  status.setAttribute("role", "status");
  const logout = button("Sign out", "secondary-button", async () => {
    logout.disabled = true;
    status.textContent = "Signing out…";
    try {
      const result = await request("/auth/logout", "POST");
      if (result?.ok !== true)
        throw new Error("The account service did not confirm sign-out.");
      location.replace("/login");
    } catch (error) {
      status.textContent = error.message;
      logout.disabled = false;
    }
  });
  logout.disabled = !session.csrfToken;
  dialog.append(
    close,
    title,
    element("p", "account-email", session.email),
    logout,
    status,
  );
  if (!session.csrfToken) {
    const signin = element(
      "a",
      "text-button",
      "Sign in again to restore account controls",
    );
    signin.href = loginDestination();
    dialog.append(signin);
  }

  let loadAccess = () => {};
  if (session.isAdmin) {
    const section = element("section", "account-access");
    section.append(element("h3", "", "Manage access"));
    const form = element("form", "access-form");
    form.id = "access-form";
    const email = element("input");
    email.id = "access-email";
    email.type = "email";
    email.required = true;
    email.maxLength = 254;
    email.autocomplete = "email";
    const emailLabel = element("label", "", "Email");
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
      "For an account that requests approval after signing in, enter the Google account ID shown on its approval page.",
    );
    const grant = element("button", "primary-button", "Grant access");
    grant.type = "submit";
    form.append(emailLabel, email, subjectLabel, subject, hint, grant);
    const list = element("div", "access-list");
    list.id = "access-list";
    const accessStatus = element("p", "account-status");
    accessStatus.id = "access-status";
    accessStatus.setAttribute("role", "status");
    let busy = false;
    const refresh = button("Refresh", "text-button", () => loadAccess());
    function setBusy(value) {
      busy = value;
      for (const control of section.querySelectorAll("input, button"))
        control.disabled = busy || !session.csrfToken;
      refresh.disabled = busy;
    }
    async function refreshList() {
      const data = await request("/api/admin/access");
      if (
        !data ||
        typeof data.adminEmail !== "string" ||
        !Array.isArray(data.grants) ||
        data.grants.some(
          (item) =>
            !item ||
            typeof item.email !== "string" ||
            typeof item.enabled !== "boolean" ||
            typeof item.isAdmin !== "boolean" ||
            (item.subject !== null && typeof item.subject !== "string"),
        )
      )
        throw new Error("The access list returned an invalid response.");
      const rows = data.grants.map((item) => {
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
              mutate(item.enabled ? "DELETE" : "POST", { email: item.email }),
            ),
          );
        return row;
      });
      list.replaceChildren(...rows);
      setBusy(busy);
    }
    loadAccess = async () => {
      if (busy) return;
      setBusy(true);
      accessStatus.textContent = "Loading access list…";
      try {
        await refreshList();
        accessStatus.textContent = "";
      } catch (error) {
        accessStatus.textContent = error.message;
      } finally {
        setBusy(false);
      }
    };
    async function mutate(method, body) {
      if (busy) return;
      setBusy(true);
      accessStatus.textContent =
        method === "DELETE" ? "Revoking access…" : "Granting access…";
      let confirmed = false;
      try {
        const result = await request("/api/admin/access", method, body);
        if (result?.ok !== true)
          throw new Error("The account service did not confirm the change.");
        confirmed = true;
        await refreshList();
        accessStatus.textContent = `${body.email}: ${method === "DELETE" ? "access revoked" : "access granted"}.`;
        if (method === "POST") form.reset();
      } catch (error) {
        accessStatus.textContent = confirmed
          ? `Access was updated, but the list could not refresh. ${error.message} Use Refresh to check it.`
          : error.message;
      } finally {
        setBusy(false);
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const identity = subject.value.trim();
      mutate("POST", {
        email: email.value.trim().toLowerCase(),
        ...(identity ? { subject: identity } : {}),
      });
    });
    section.append(form, refresh, list, accessStatus);
    dialog.append(section);
    setBusy(false);
  }
  const toggle = button("Account", "quiet-button account-toggle", () => {
    dialog.showModal();
    loadAccess();
  });
  document.querySelector(".account-controls")?.append(toggle);
  document.body.append(dialog);
  return true;
}
