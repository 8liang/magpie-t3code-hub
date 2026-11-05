import type { CliproxyApiCallResponse } from "./types";

/** The CLIProxyAPI management `api-call` error envelope, in one place. */
export function apiReply(status_code: number, error: string): CliproxyApiCallResponse {
  return { status_code, body: JSON.stringify({ error }) };
}
