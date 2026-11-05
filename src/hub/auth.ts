import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

const TOKEN_LOCK_WAIT_MS = 10_000;
const TOKEN_LOCK_STALE_MS = 5_000;

export interface ResolvedToken {
  token: string;
  path?: string;
  created: boolean;
}

/** XDG config root, honoring the env object it is given. */
export function xdgConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

/**
 * One data-dir rule for the server, token CLI and verify CLI. Relative
 * MAGPIE_T3CODE_HUB_HOME values resolve against the home directory, not the
 * caller's cwd, so every process agrees on the same path.
 */
function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  override?: unknown,
  options: { relativeTo?: "home" | "cwd" } = {},
): string {
  const explicit = typeof override === "string" && override.trim() ? override.trim() : "";
  const fallback = join(xdgConfigDir(env), "magpie-t3code-hub");
  const raw = expandHome(explicit || env.MAGPIE_T3CODE_HUB_HOME?.trim() || fallback);
  if (isAbsolute(raw)) return resolvePath(raw);
  return resolvePath(options.relativeTo === "cwd" ? process.cwd() : homedir(), raw);
}

export interface TokenFileRead {
  token?: string;
  /** ENOENT, EACCES, … when the file could not be read. */
  code?: string;
}

/** Reads a token file without creating anything, preserving the failure code. */
export function readTokenFileDetailed(path: string): TokenFileRead {
  try {
    const saved = readFileSync(path, "utf8").trim();
    return saved ? { token: saved } : {};
  } catch (error) {
    return { code: errorCode(error) };
  }
}

/** Reads a token file without creating anything. */
export function readTokenFile(path: string): string | undefined {
  return readTokenFileDetailed(path).token;
}

/** Reads `<dataDir>/token` without creating anything. */
export function readSavedToken(dataDir: string): string | undefined {
  return readTokenFile(join(dataDir, "token"));
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function tokenError(path: string, error: unknown): Error {
  const code = errorCode(error) ?? "unknown error";
  return new Error(
    `Cannot create the management key at ${path} (${code}). ` +
      "Set MAGPIE_T3CODE_HUB_TOKEN or the plugin's managementKey option, " +
      "or point MAGPIE_T3CODE_HUB_HOME at a writable directory.",
  );
}

/** Async wait: resolveToken runs in the long-lived Magpie plugin host. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockOwner(lockPath: string): string | undefined {
  return readTokenFile(lockPath);
}

interface LockEntry {
  gen: number;
  path: string;
  owner?: string;
  mtimeMs: number;
}

function listLocks(lockPrefix: string): LockEntry[] {
  const dir = dirname(lockPrefix);
  const base = basename(lockPrefix);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: LockEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const suffix = name.slice(base.length);
    if (!/^\d+$/.test(suffix)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      entries.push({ gen: Number(suffix), path, owner: lockOwner(path), mtimeMs: stat.mtimeMs });
    } catch {
      // The file vanished between readdir and stat.
    }
  }
  return entries.sort((left, right) => left.gen - right.gen);
}

function tryAcquire(lockPath: string, owner: string): boolean {
  try {
    writeFileSync(lockPath, `${owner}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

/**
 * Returns the current locks when `owner` still holds the newest, fresh
 * `generation`; undefined when a newer generation exists or ours went stale.
 */
function ownedLocks(lockPrefix: string, generation: number, owner: string): LockEntry[] | undefined {
  const locks = listLocks(lockPrefix);
  const own = locks.find((lock) => lock.gen === generation);
  if (
    locks.some((lock) => lock.gen > generation) ||
    !own ||
    own.owner !== owner ||
    Date.now() - own.mtimeMs > TOKEN_LOCK_STALE_MS
  ) {
    return undefined;
  }
  return locks;
}

/** Only the owner may release its lock. */
function releaseLock(lockPath: string, owner: string): void {
  try {
    if (lockOwner(lockPath) === owner) rmSync(lockPath, { force: true });
  } catch {
    // Already gone or unreadable: nothing to release.
  }
}

/**
 * The management key T3 Code sends as `Authorization: Bearer …`.
 *
 * Precedence: plugin option > environment > token file. When none exists, a
 * random token is generated and stored 0600 so the hub never runs keyless.
 *
 * Creation and repair use generation-numbered lock files
 * (`token.lock.00000001`, …). A waiter never deletes or moves a fresh lock: it
 * waits while the newest lock is fresh, and only creates a higher generation
 * after the newest has gone stale. That avoids the rename/restore race where a
 * third process could take a path mid-recovery.
 *
 * This is async on purpose: the plugin host must keep answering JSON-RPC while
 * one process waits for another's lock.
 */
export async function resolveToken(input: {
  optionToken?: unknown;
  dataDir: string;
  env?: Record<string, string | undefined>;
}): Promise<ResolvedToken> {
  const fromOption = typeof input.optionToken === "string" ? input.optionToken.trim() : "";
  if (fromOption) return { token: fromOption, created: false };

  const env = input.env ?? process.env;
  const fromEnv = env.MAGPIE_T3CODE_HUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, created: false };

  const path = join(input.dataDir, "token");
  const saved = readSavedToken(input.dataDir);
  if (saved) return { token: saved, path, created: false };

  try {
    mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw tokenError(path, error);
  }

  const token = `mgt_${randomBytes(24).toString("base64url")}`;
  const owner = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const lockPrefix = `${path}.lock.`;
  const deadline = Date.now() + TOKEN_LOCK_WAIT_MS;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for the management-key lock at ${lockPrefix}*. ` +
          "Remove stale locks if no other magpie-t3code-hub is starting.",
      );
    }

    const raced = readSavedToken(input.dataDir);
    if (raced) return { token: raced, path, created: false };

    const locks = listLocks(lockPrefix);
    const newest = locks[locks.length - 1];
    let generation: number;
    if (!newest) {
      generation = 1;
    } else if (Date.now() - newest.mtimeMs > TOKEN_LOCK_STALE_MS) {
      generation = newest.gen + 1;
    } else {
      // A live owner holds the newest lock; wait for it to write/release.
      await sleep(25);
      continue;
    }

    const lockPath = `${lockPrefix}${String(generation).padStart(8, "0")}`;
    let acquired = false;
    try {
      acquired = tryAcquire(lockPath, owner);
    } catch (error) {
      throw tokenError(path, error);
    }
    if (!acquired) {
      await sleep(25);
      continue;
    }

    try {
      // A newer generation means our lock went stale while we were scheduled;
      // do not let an old owner overwrite a newer owner's token.
      const current = ownedLocks(lockPrefix, generation, owner);
      if (!current) {
        await sleep(25);
        continue;
      }

      // Best-effort cleanup of older stale generations.
      for (const lock of current) {
        if (lock.gen < generation && Date.now() - lock.mtimeMs > TOKEN_LOCK_STALE_MS) {
          try {
            rmSync(lock.path, { force: true });
          } catch {
            // Ignore a lock that just disappeared.
          }
        }
      }

      const inside = readSavedToken(input.dataDir);
      if (inside) return { token: inside, path, created: false };

      // Final ownership/freshness check immediately before installing. The
      // install itself is link-based, so a stalled owner can never overwrite a
      // token another owner already installed.
      if (!ownedLocks(lockPrefix, generation, owner)) {
        await sleep(25);
        continue;
      }

      const tempPath = `${path}.tmp.${owner}`;
      try {
        try {
          writeFileSync(tempPath, `${token}\n`, { mode: 0o600 });
          try {
            chmodSync(tempPath, 0o600);
          } catch {
            // Best effort on filesystems without POSIX modes.
          }
        } catch (error) {
          throw tokenError(path, error);
        }

        const install = (): boolean => {
          try {
            linkSync(tempPath, path);
            return true;
          } catch (error) {
            if (errorCode(error) === "EEXIST") return false;
            throw tokenError(path, error);
          }
        };

        let installed = install();
        if (!installed) {
          const existing = readSavedToken(input.dataDir);
          if (existing) return { token: existing, path, created: false };

          // Repairing an empty file is destructive: a newer generation may
          // have installed a token while this owner was stalled between the
          // final ownership check and here. Re-check both before deleting.
          if (!ownedLocks(lockPrefix, generation, owner)) {
            await sleep(25);
            continue;
          }
          const racedAfterCheck = readSavedToken(input.dataDir);
          if (racedAfterCheck) {
            return { token: racedAfterCheck, path, created: false };
          }

          // Empty/whitespace-only legacy file: exactly one repairer removes
          // it, then competitors race only on the atomic link, never on a
          // partial write.
          try {
            unlinkSync(path);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw tokenError(path, error);
          }
          installed = install();
          if (!installed) {
            const raced = readSavedToken(input.dataDir);
            if (raced) return { token: raced, path, created: false };
            throw tokenError(path, new Error("the token file is still empty"));
          }
        }

        // The link succeeded, so the file is ours unless someone replaced it
        // since; only report "created" for the key this process generated.
        const canonical = readSavedToken(input.dataDir) ?? token;
        return { token: canonical, path, created: canonical === token };
      } finally {
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // Best effort; a leftover .tmp file is ignored by readers.
        }
      }
    } finally {
      releaseLock(lockPath, owner);
    }
  }
}

/** Constant-time comparison that does not throw on different lengths. */
export function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // timingSafeEqual needs equal byte lengths; this is the only length check.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
