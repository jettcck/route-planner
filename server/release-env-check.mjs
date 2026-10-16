import { pathToFileURL } from "node:url";

// These belong to the build jobs. AI credentials belong only to the backend.
export const REQUIRED_RELEASE_FIELDS = [
  "VITE_AUTH_ENDPOINT",
  "TAURI_SIGNING_PRIVATE_KEY",
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

export function releaseEnvironmentErrors(env) {
  const errors = REQUIRED_RELEASE_FIELDS
    .filter((name) => !String(env[name] || "").trim())
    .map((name) => `Missing release configuration: ${name}`);
  const value = String(env.VITE_AUTH_ENDPOINT || "").trim();
  if (value) {
    try {
      const endpoint = new URL(value);
      if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username ||
          endpoint.password || endpoint.search || endpoint.hash) {
        errors.push("VITE_AUTH_ENDPOINT must use HTTPS without credentials, query parameters or fragments");
      }
    } catch {
      errors.push("VITE_AUTH_ENDPOINT must be a valid HTTPS URL");
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = releaseEnvironmentErrors(process.env);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Release configuration present; key validity and backend readiness still require separate verification");
  }
}
