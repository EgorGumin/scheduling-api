import { PlatformError } from "../types.js";

/** `at://<did>/<collection>/<rkey>` */
export interface AtUri {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
}

const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

export function parseAtUri(value: string): AtUri {
  const match = AT_URI.exec(value);
  if (match === null) {
    throw new PlatformError("constraint_violated", `not an AT-URI: ${value}`, false);
  }
  const [, did, collection, rkey] = match;
  if (did === undefined || collection === undefined || rkey === undefined) {
    throw new PlatformError("constraint_violated", `not an AT-URI: ${value}`, false);
  }
  return { did, collection, rkey };
}

export function isAtUri(value: string): boolean {
  return AT_URI.test(value);
}
