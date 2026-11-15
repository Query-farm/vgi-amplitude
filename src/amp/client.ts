/**
 * Amplitude API client: credentials, region, rate limits and concurrency.
 *
 * - **Auth.** An `amplitude` DuckDB secret carries the project's API_KEY and
 *   SECRET_KEY, sent as HTTP Basic auth (`api_key:secret_key`), plus REGION
 *   (`us`, the default, or `eu`) or an explicit BASE_URL (a loopback fixture server,
 *   or a proxy). The keys are read from the secret on every call, never enter
 *   table-function state, and are never sent to another origin.
 * - **Rate limits.** Amplitude answers 429 when a concurrency, request-rate or cost
 *   budget is exhausted. The client honours `Retry-After`, otherwise backs off
 *   exponentially with jitter, and gives up after a bounded number of attempts with
 *   the error Amplitude returned (cost budgets refill hourly; retrying immediately
 *   cannot clear them). 5xx and network errors retry the same way.
 * - **Concurrency.** Amplitude allows 4 concurrent Export API requests, 5 concurrent
 *   Dashboard REST requests (cohort downloads share that pool) and a concurrent cost
 *   of 4 on the Taxonomy API, per project. Requests from one worker process queue
 *   behind an in-process semaphore per project and API family so a parallel DuckDB
 *   plan cannot exceed them on its own.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "amplitude";
export const REGION_URLS: Record<string, string> = {
  us: "https://amplitude.com",
  eu: "https://analytics.eu.amplitude.com",
};
export const TIMEOUT_MS = 120_000;
export const MAX_ATTEMPTS = 6;
/** Longest single back-off wait. */
export const MAX_WAIT_MS = 60_000;
const USER_AGENT = `vgi-amplitude-worker/${VERSION}`;

export class AmpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

export interface AmpConfig {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AmpError(`amplitude secret: base_url '${raw}' is not a URL (expected e.g. https://amplitude.com)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new AmpError(
      "amplitude secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `amplitude` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): AmpConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new AmpError(
      "no amplitude secret: run CREATE SECRET (TYPE amplitude, API_KEY '…', SECRET_KEY '…') " +
        "(add REGION 'eu' for an EU data-residency project)",
    );
  }
  const apiKey = str(s.api_key);
  const secretKey = str(s.secret_key);
  if (!apiKey || !secretKey) {
    throw new AmpError("amplitude secret: API_KEY and SECRET_KEY are both required (Project settings > General)");
  }
  const explicit = str(s.base_url);
  let baseUrl: string;
  if (explicit) baseUrl = normalizeBaseUrl(explicit);
  else {
    const region = (str(s.region) ?? "us").toLowerCase();
    const url = REGION_URLS[region];
    if (!url) throw new AmpError(`amplitude secret: REGION must be 'us' or 'eu', not '${region}'`);
    baseUrl = url;
  }
  return { baseUrl, apiKey, secretKey };
}

/** The API families Amplitude limits separately. */
export type Bucket = "export" | "dashboard" | "taxonomy";
const LIMITS: Record<Bucket, number> = { export: 4, dashboard: 5, taxonomy: 4 };

/** A tiny FIFO semaphore. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
const semaphores = new Map<string, Semaphore>();

function semaphoreFor(cfg: AmpConfig, bucket: Bucket): Semaphore {
  // Key by project (origin + a hash of the API key), never by the raw key.
  const key = `${cfg.baseUrl}|${Bun.hash(cfg.apiKey).toString(36)}|${bucket}`;
  let s = semaphores.get(key);
  if (!s) {
    s = new Semaphore(LIMITS[bucket]);
    semaphores.set(key, s);
  }
  return s;
}

/** A query value: one value, a repeated parameter, or absent. */
export type QueryValue = string | string[] | undefined | null;

/** Build the request URL; repeated parameters (`e=…&e=…`) come from arrays. */
export function buildUrl(cfg: AmpConfig, path: string, query?: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (x !== "") qs.append(k, x);
  }
  const q = qs.toString();
  return `${cfg.baseUrl}${path}${q ? `?${q}` : ""}`;
}

/** Refuse to send the keys to an origin other than the configured one. */
export function assertSameOrigin(cfg: AmpConfig, url: string): void {
  if (new URL(url).origin !== new URL(cfg.baseUrl).origin) {
    throw new AmpError(`refusing to send Amplitude credentials to ${new URL(url).origin}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Back-off after a failed attempt: Retry-After when given, else exponential with jitter. */
export function retryDelayMs(headers: Headers | undefined, attempt: number, random = Math.random): number {
  const retry = headers?.get("Retry-After");
  if (retry && /^\d+(\.\d+)?$/.test(retry)) return Math.min(Number(retry) * 1000, MAX_WAIT_MS);
  const base = Math.min(500 * 2 ** attempt, MAX_WAIT_MS);
  return Math.round(base / 2 + random() * (base / 2));
}

function authHeader(cfg: AmpConfig): string {
  return `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.secretKey}`).toString("base64")}`;
}

/** Show the path + query of a URL in errors (the keys travel in a header, never in a URL). */
export function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

export interface RequestOptions {
  bucket: Bucket;
  /** HTTP statuses that are returned to the caller instead of raising (e.g. 404). */
  pass?: number[];
  /** Follow a redirect to another origin WITHOUT credentials (pre-signed S3 links). */
  followForeignRedirect?: boolean;
  accept?: string;
  timeoutMs?: number;
}

/**
 * GET an Amplitude URL and return the open Response (the body is not read).
 * The concurrency slot is held until `release()` is called, so a streamed
 * download counts against Amplitude's concurrency limit while it runs.
 */
export async function ampFetch(
  cfg: AmpConfig,
  path: string,
  query: Record<string, QueryValue> | undefined,
  opts: RequestOptions,
): Promise<{ res: Response; release: () => void }> {
  const url = buildUrl(cfg, path, query);
  assertSameOrigin(cfg, url);
  const sem = semaphoreFor(cfg, opts.bucket);
  for (let attempt = 1; ; attempt++) {
    const release = await sem.acquire();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: opts.accept ?? "application/json",
          Authorization: authHeader(cfg),
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      release();
      if (attempt >= MAX_ATTEMPTS) throw new AmpError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(retryDelayMs(undefined, attempt));
      continue;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
      await res.body?.cancel();
      const target = new URL(res.headers.get("Location") as string, url).href;
      if (new URL(target).origin === new URL(cfg.baseUrl).origin) {
        release();
        return ampFetch(cfg, new URL(target).pathname, Object.fromEntries(new URL(target).searchParams), opts);
      }
      if (!opts.followForeignRedirect) {
        release();
        throw new AmpError(`GET ${redact(url)} redirected to another host; not following`, res.status);
      }
      // A pre-signed download link: fetched without the Amplitude credentials.
      try {
        const signed = await fetch(target, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
        });
        if (!signed.ok) {
          const body = (await signed.text()).slice(0, 300);
          throw new AmpError(
            `download of the pre-signed link failed with HTTP ${signed.status}: ${body}`,
            signed.status,
          );
        }
        return { res: signed, release };
      } catch (err) {
        release();
        throw err;
      }
    }
    if (res.ok || opts.pass?.includes(res.status)) return { res, release };
    const body = (await res.text()).slice(0, 500);
    release();
    // 504 is the Export API giving up on a too-large range: the caller shrinks the range instead.
    const retryable = res.status === 429 || (res.status >= 500 && res.status !== 504);
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new AmpError(
        `GET ${redact(url)} failed with HTTP ${res.status}: ${summary(body)}${res.status === 429 ? " (Amplitude rate, concurrency or cost limit; retries exhausted)" : ""}`,
        res.status,
        body,
      );
    }
    const delay = retryDelayMs(res.headers, attempt);
    log.info(`amplitude: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Amplitude errors come as JSON (`{"error": …}`) or plain text; keep them short. */
function summary(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    const m = j.error ?? j.message;
    if (m) return typeof m === "string" ? m : JSON.stringify(m);
  } catch {
    // plain text
  }
  return text.trim().slice(0, 300) || "(empty body)";
}

/** GET a JSON resource. */
export async function ampGet(
  cfg: AmpConfig,
  path: string,
  query: Record<string, QueryValue> | undefined,
  bucket: Bucket,
): Promise<unknown> {
  const { res, release } = await ampFetch(cfg, path, query, { bucket });
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new AmpError(`GET ${path}: Amplitude returned a non-JSON body: ${text.slice(0, 200)}`, res.status);
    }
  } finally {
    release();
  }
}
