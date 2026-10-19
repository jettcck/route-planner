import { pathToFileURL } from "node:url";

// These belong to the build jobs. AI credentials belong only to the backend.
// VITE_AUTH_ENDPOINT 故意不在这里：单人私人版不搭载任何账号服务，
// 把它列为必填会让每次发版都卡在一个应用已经不需要的功能上。
export const REQUIRED_RELEASE_FIELDS = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

// VITE_AUTH_ENDPOINT 变为可选项：填了才校验，留空表示"本构建不带账号服务"，
// 这是当前支持的默认形态。
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
