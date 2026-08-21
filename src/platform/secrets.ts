import { PlatformError } from "./types.js";

const ENV_SCHEME = "secret://env/";

/**
 * An unset variable is a broken deployment, so it fails as `unavailable` and the
 * credential keeps its state.
 */
export function resolveSecret(ref: string): string {
  if (!ref.startsWith(ENV_SCHEME)) {
    throw new PlatformError("unavailable", `unsupported credential reference ${ref}`, false);
  }

  const name = ref.slice(ENV_SCHEME.length);
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new PlatformError("unavailable", `${name} is not set`, false);
  }
  return value;
}
