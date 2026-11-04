"use strict";

function safeReturnPath(value, origin) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, origin);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      url.origin !== origin ||
      decodedPath.startsWith("//") ||
      decodedPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decodedPath) ||
      decodedPath.startsWith("/auth/") ||
      ["/login", "/login.html"].includes(decodedPath)
    )
      return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

const parameters = new URLSearchParams(window.location.search);
const next = safeReturnPath(parameters.get("next"), window.location.origin);
document.querySelector("#google-login").href =
  `/auth/google/start?${new URLSearchParams({ next })}`;
const messages = {
  access_denied:
    "This account does not have access. Ask the administrator to add your email address.",
  authentication_required: "Please sign in to continue.",
  enrollment_required:
    "This account needs an administrator to approve its Google account ID before it can sign in.",
  invalid_state: "This sign-in attempt expired. Please try again.",
  invalid_request:
    "This sign-in attempt could not be completed. Please try again.",
  login_cancelled: "Sign-in was cancelled. You can try again when ready.",
  invalid_identity:
    "This Google account could not be verified. Please try another account.",
  configuration_error: "Sign-in is not configured yet. Please try again later.",
  storage_unavailable:
    "Sign-in is temporarily unavailable. Please try again later.",
  google_unavailable:
    "Google sign-in is temporarily unavailable. Please try again later.",
  authentication_unavailable:
    "Sign-in is temporarily unavailable. Please try again later.",
};
const error = parameters.get("error");
const message = Object.hasOwn(messages, error) ? messages[error] : null;
if (message) {
  const status = document.querySelector("#login-message");
  status.textContent = message;
  status.hidden = false;
}

async function loadEnrollment() {
  const status = document.querySelector("#login-message");
  try {
    const response = await fetch("/api/enrollment", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(
        "Approval details could not be loaded. Please sign in again.",
      );
    const data = await response.json();
    const enrollment = data?.enrollment;
    if (!enrollment) {
      status.textContent =
        "This approval request expired. Sign in again to create a new request.";
      return;
    }
    if (
      typeof enrollment.email !== "string" ||
      !enrollment.email ||
      enrollment.email.length > 254 ||
      typeof enrollment.subject !== "string" ||
      !enrollment.subject ||
      enrollment.subject.length > 255 ||
      !Number.isFinite(enrollment.expiresAt) ||
      enrollment.expiresAt * 1000 <= Date.now()
    )
      throw new Error(
        "Approval details could not be verified. Please sign in again.",
      );
    document.querySelector("#enrollment-email").value = enrollment.email;
    document.querySelector("#enrollment-subject").value = enrollment.subject;
    document.querySelector("#enrollment-details").hidden = false;
    document
      .querySelector("#copy-enrollment")
      .addEventListener("click", async () => {
        const result = document.querySelector("#enrollment-status");
        try {
          await navigator.clipboard.writeText(
            `Email: ${enrollment.email}\nGoogle account ID: ${enrollment.subject}`,
          );
          result.textContent = "Approval details copied.";
        } catch {
          result.textContent =
            "Select and copy the email and account ID above.";
        }
      });
  } catch (error) {
    status.textContent =
      error instanceof SyntaxError
        ? "Approval details could not be loaded. Please sign in again."
        : error.message;
  }
}

if (error === "enrollment_required") loadEnrollment();
