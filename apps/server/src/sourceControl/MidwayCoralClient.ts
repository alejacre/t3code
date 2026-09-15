// @effect-diagnostics nodeBuiltinImport:off - Coral needs Node HTTPS for the system Amazon CA store.
// @effect-diagnostics globalDate:off - Cookie expiry follows HTTP wall-clock semantics.
// @effect-diagnostics globalTimers:off - The injected retry delay has a production timer default.
// @effect-diagnostics preferSchemaOverJson:off - Coral envelopes are schema-decoded by their service client.
// @effect-diagnostics instanceOfSchema:off - Tagged transport errors must pass through without remapping.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 503, 504]);
const decodeCoralError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ __type: Schema.String })),
);

/** Coral reports throttling as HTTP 400, so status-only retries miss valid rate-limit responses. */
function isRetryableResponse(response: RawHttpResponse): boolean {
  if (RETRYABLE_STATUSES.has(response.status)) return true;
  if (response.status !== 400) return false;
  const error = decodeCoralError(response.body);
  return error._tag === "Some" && /(?:^|#)ThrottlingException$/u.test(error.value.__type);
}
const RETRYABLE_OPERATIONS = new Set([
  "GetRevisionsByReview",
  "GetRevision",
  "GetApprovalStatus",
  "getSnapshots",
  "rawDiff",
  "getBlob",
]);

export interface RawHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
}

export type RawRequest = (input: RawHttpRequest, signal?: AbortSignal) => Promise<RawHttpResponse>;

export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly hostOnly: boolean;
  readonly expiresAt: number | null;
}

export class MidwayCoralAuthenticationError extends Schema.TaggedError<MidwayCoralAuthenticationError>()(
  "MidwayCoralAuthenticationError",
  {
    endpoint: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {
  get detail(): string {
    if (this.status === 403) {
      return "Amazon denied access to the code review service. Run `mwinit` and retry. If access is still denied, check your service permissions.";
    }
    return "CRUX could not use the current Midway session. Run `mwinit` and retry.";
  }
}

export class MidwayCoralRequestError extends Schema.TaggedError<MidwayCoralRequestError>()(
  "MidwayCoralRequestError",
  {
    endpoint: Schema.String,
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    return "The Amazon code review service could not be reached.";
  }
}

export type MidwayCoralError = MidwayCoralAuthenticationError | MidwayCoralRequestError;

export interface MidwayCoralCall {
  readonly endpoint: string;
  readonly target: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function defaultCookiePath(): string {
  return NodePath.join(NodeOS.homedir(), ".midway", "cookie");
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  return cookie.hostOnly
    ? host === cookie.domain
    : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function defaultPath(url: URL): string {
  const slash = url.pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : url.pathname.slice(0, slash + 1);
}

/** Parses the Netscape cookie file written by mwinit without exposing cookie values to logs. */
export function parseMidwayCookieFile(text: string): ReadonlyArray<StoredCookie> {
  const cookies: StoredCookie[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match =
      /^(?<httpOnly>#HttpOnly_)?\.?(?<domain>\S+)\s+(?<includeSubdomains>TRUE|FALSE)\s+(?<path>\S+)\s+(?<secure>TRUE|FALSE)\s+(?<expires>\d+)\s+(?<name>\S+)(?:\s+(?<value>\S+))?/u.exec(
        line,
      );
    if (!match?.groups) continue;
    const {
      domain,
      expires: rawExpires,
      name,
      path,
      secure,
      includeSubdomains,
      value,
    } = match.groups;
    if (
      domain === undefined ||
      rawExpires === undefined ||
      name === undefined ||
      path === undefined
    ) {
      continue;
    }
    const expires = Number(rawExpires);
    cookies.push({
      name,
      value: value ?? "",
      domain: domain.toLowerCase(),
      path,
      secure: secure === "TRUE",
      hostOnly: includeSubdomains !== "TRUE",
      expiresAt: expires === 0 ? null : expires * 1_000,
    });
  }
  return cookies;
}

function parseSetCookie(value: string, requestUrl: URL): StoredCookie | null {
  const parts = value.split(";");
  const pair = parts.shift();
  if (!pair) return null;
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;

  const requestHost = requestUrl.hostname.toLowerCase();
  let domain = requestHost;
  let cookiePath = defaultPath(requestUrl);
  let secure = false;
  let hostOnly = true;
  let expiresAt: number | null = null;

  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    const equals = attribute.indexOf("=");
    const key = (equals < 0 ? attribute : attribute.slice(0, equals)).toLowerCase();
    const attributeValue = equals < 0 ? "" : attribute.slice(equals + 1).trim();
    if (key === "domain" && attributeValue) {
      const candidate = attributeValue.replace(/^\./u, "").toLowerCase();
      if (requestHost === candidate || requestHost.endsWith(`.${candidate}`)) {
        domain = candidate;
        hostOnly = false;
      }
    } else if (key === "path" && attributeValue.startsWith("/")) {
      cookiePath = attributeValue;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "max-age") {
      const seconds = Number(attributeValue);
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1_000;
    } else if (key === "expires") {
      const timestamp = Date.parse(attributeValue);
      if (Number.isFinite(timestamp)) expiresAt = timestamp;
    }
  }

  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    domain,
    path: cookiePath,
    secure,
    hostOnly,
    expiresAt,
  };
}

class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly readCookieFile: () => string;

  constructor(readCookieFile: () => string) {
    this.readCookieFile = readCookieFile;
    this.set({
      name: "sentry_braveheart",
      value: "1",
      domain: "sentry.amazon.com",
      path: "/",
      secure: true,
      hostOnly: true,
      expiresAt: null,
    });
  }

  syncMidwayFile(): void {
    let text: string;
    try {
      text = this.readCookieFile();
    } catch {
      return;
    }
    const now = Date.now();
    for (const cookie of parseMidwayCookieFile(text)) {
      // mwinit leaves expired service cookies in the file. Do not let them overwrite a fresh
      // service cookie that this process obtained during warm-up.
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
      this.set(cookie);
    }
  }

  store(url: URL, headers: RawHttpResponse["headers"]): void {
    const values = headers["set-cookie"];
    const setCookies = Array.isArray(values) ? values : values === undefined ? [] : [values];
    for (const value of setCookies) {
      const cookie = parseSetCookie(value, url);
      if (cookie) this.set(cookie);
    }
  }

  header(url: URL): string | null {
    const now = Date.now();
    const pairs: string[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && url.protocol !== "https:") continue;
      if (!domainMatches(url.hostname.toLowerCase(), cookie)) continue;
      if (!pathMatches(url.pathname || "/", cookie.path)) continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
    return pairs.length === 0 ? null : pairs.join("; ");
  }

  private set(cookie: StoredCookie): void {
    this.cookies.set(`${cookie.domain}\0${cookie.path}\0${cookie.name}`, cookie);
  }
}

function headerValue(headers: RawHttpResponse["headers"], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return typeof value === "string" ? value : value?.[0];
}

function isRetryableTarget(target: string): boolean {
  const operation = target.slice(target.lastIndexOf(".") + 1);
  return RETRYABLE_OPERATIONS.has(operation);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAllowedRedirect(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  return ["amazon.com", "aws.dev", "amazon.dev", "a2z.com"].some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  );
}

function nodeRequest(input: RawHttpRequest, signal?: AbortSignal): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = NodeHttps.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        // Corporate roots augment the public trust store; redirects may use either chain.
        ca: [...NodeTls.getCACertificates("default"), ...NodeTls.getCACertificates("system")],
        ...(signal === undefined ? {} : { signal }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += buffer.length;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Amazon code review response exceeded the size limit"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers: Record<string, string | ReadonlyArray<string> | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) headers[name] = value;
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Amazon code review request timed out"));
    });
    request.on("error", reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

export interface MidwayCoralDependencies {
  readonly request?: RawRequest;
  readonly readCookieFile?: () => string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** Tracks one coalesced warm-up and the live callers that still depend on it. */
interface SharedWarmup {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  waiters: number;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Creates the dependency-free Coral client used by T3's internal CRUX integration.
 *
 * AgentSpaces uses Midway Client Suite with a cookie-file fallback. T3's reproducible public
 * pnpm build cannot install that internal native package, so this client implements the same
 * fallback path directly while retaining system certificate validation and bounded redirects.
 */
export function makeWithDependencies(
  dependencies: MidwayCoralDependencies = {},
): MidwayCoralClient["Service"] {
  const request = dependencies.request ?? nodeRequest;
  const readCookieFile =
    dependencies.readCookieFile ?? (() => NodeFS.readFileSync(defaultCookiePath(), "utf8"));
  const sleep = dependencies.sleep ?? defaultSleep;
  const jar = new CookieJar(readCookieFile);
  const warmedOrigins = new Set<string>();
  const warmingOrigins = new Map<string, SharedWarmup>();

  const requestWithCookies = async (
    url: URL,
    method: "GET" | "POST",
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    body?: string,
  ): Promise<RawHttpResponse> => {
    const cookie = jar.header(url);
    const response = await request(
      {
        url: url.toString(),
        method,
        headers: { ...headers, ...(cookie === null ? {} : { Cookie: cookie }) },
        ...(body === undefined ? {} : { body }),
      },
      signal,
    );
    jar.store(url, response.headers);
    return response;
  };

  const warmOrigin = async (endpoint: URL, signal: AbortSignal): Promise<void> => {
    const origin = endpoint.origin;
    if (jar.header(new URL("https://midway-auth.amazon.com/")) === null) {
      throw new MidwayCoralAuthenticationError({ endpoint: endpoint.toString() });
    }

    let current = new URL(endpoint);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await requestWithCookies(
        current,
        "GET",
        { Accept: "application/json" },
        signal,
      );
      const location = headerValue(response.headers, "location");
      if (isRedirect(response.status) && location) {
        const next = new URL(location, current);
        if (!isAllowedRedirect(next)) {
          throw new MidwayCoralRequestError({
            endpoint: endpoint.toString(),
            operation: "MidwayRedirect",
            status: response.status,
          });
        }
        current = next;
        continue;
      }
      if (
        current.hostname.includes("midway-auth") ||
        response.status === 401 ||
        response.status === 403
      ) {
        throw new MidwayCoralAuthenticationError({
          endpoint: endpoint.toString(),
          status: response.status,
        });
      }
      warmedOrigins.add(origin);
      return;
    }
    throw new MidwayCoralAuthenticationError({ endpoint: endpoint.toString() });
  };

  /** Keeps a shared warm-up alive until every waiting caller has been interrupted. */
  const waitForWarmup = (
    origin: string,
    warmup: SharedWarmup,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      warmup.waiters += 1;
      let waiting = true;

      function stopWaiting(): boolean {
        if (!waiting) return false;
        waiting = false;
        warmup.waiters -= 1;
        signal.removeEventListener("abort", onAbort);
        return true;
      }

      function onAbort(): void {
        if (!stopWaiting()) return;
        if (warmup.waiters === 0) {
          if (warmingOrigins.get(origin) === warmup) warmingOrigins.delete(origin);
          warmup.controller.abort(signal.reason);
        }
        reject(signal.reason);
      }

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      warmup.promise.then(
        () => {
          if (stopWaiting()) resolve();
        },
        (cause) => {
          if (stopWaiting()) reject(cause);
        },
      );
    });

  const warm = (endpoint: URL, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);

    const origin = endpoint.origin;
    if (warmedOrigins.has(origin)) return Promise.resolve();

    let warmup = warmingOrigins.get(origin);
    if (warmup === undefined) {
      const controller = new AbortController();
      const promise = warmOrigin(endpoint, controller.signal);
      warmup = { controller, promise, waiters: 0 };
      warmingOrigins.set(origin, warmup);
      const cleanup = () => {
        if (warmingOrigins.get(origin) === warmup) warmingOrigins.delete(origin);
      };
      void promise.then(cleanup, cleanup);
    }
    return waitForWarmup(origin, warmup, signal);
  };

  const call = (input: MidwayCoralCall): Effect.Effect<unknown, MidwayCoralError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const endpoint = new URL(input.endpoint);
        // A call reads Midway once. Redirects and retries then use the in-memory jar plus
        // service cookies returned during that call.
        jar.syncMidwayFile();
        await warm(endpoint, signal);
        const body = JSON.stringify(input.body);
        let refreshedAuthentication = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const response = await requestWithCookies(
            endpoint,
            "POST",
            {
              "X-Amz-Target": input.target,
              Accept: "application/json",
              "Content-Type": "application/json; charset=UTF-8",
              "Content-Encoding": "amz-1.0",
              "Content-Length": String(Buffer.byteLength(body)),
            },
            signal,
            body,
          );
          const location = headerValue(response.headers, "location");
          const contentType = headerValue(response.headers, "content-type") ?? "";

          if (
            response.status === 401 ||
            response.status === 403 ||
            (response.status >= 200 && response.status < 300 && contentType.includes("text/html"))
          ) {
            warmedOrigins.delete(endpoint.origin);
            throw new MidwayCoralAuthenticationError({
              endpoint: input.endpoint,
              status: response.status,
            });
          }
          if (isRedirect(response.status) && location) {
            if (refreshedAuthentication) {
              throw new MidwayCoralAuthenticationError({ endpoint: input.endpoint });
            }
            refreshedAuthentication = true;
            warmedOrigins.delete(endpoint.origin);
            await warm(endpoint, signal);
            attempt -= 1;
            continue;
          }
          if (response.status >= 200 && response.status < 300) {
            return response.body.trim() === "" ? {} : JSON.parse(response.body);
          }
          if (
            isRetryableTarget(input.target) &&
            isRetryableResponse(response) &&
            attempt < MAX_ATTEMPTS
          ) {
            await sleep(2 ** (attempt - 1) * 1_000, signal);
            continue;
          }
          throw new MidwayCoralRequestError({
            endpoint: input.endpoint,
            operation: input.target,
            status: response.status,
          });
        }
        throw new MidwayCoralRequestError({
          endpoint: input.endpoint,
          operation: input.target,
        });
      },
      catch: (cause) => {
        if (
          cause instanceof MidwayCoralAuthenticationError ||
          cause instanceof MidwayCoralRequestError
        ) {
          return cause;
        }
        return new MidwayCoralRequestError({
          endpoint: input.endpoint,
          operation: input.target,
          cause,
        });
      },
    });

  return MidwayCoralClient.of({ call });
}

export class MidwayCoralClient extends Context.Service<
  MidwayCoralClient,
  {
    readonly call: (input: MidwayCoralCall) => Effect.Effect<unknown, MidwayCoralError>;
  }
>()("t3/sourceControl/MidwayCoralClient") {}

export const layer = Layer.succeed(MidwayCoralClient, makeWithDependencies());
