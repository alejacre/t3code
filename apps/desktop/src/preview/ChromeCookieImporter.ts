import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import type { CookiesSetDetails } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const CHROME_ROOT = `${homedir()}/Library/Application Support/Google/Chrome`;
const CHROME_LOCAL_STATE = `${CHROME_ROOT}/Local State`;
const CHROME_COOKIE_DOMAINS = [
  "amazon.com",
  "amazon.dev",
  "amazon.work",
  "a2z.com",
  "aws.dev",
  "quip-amazon.com",
] as const;
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
const CHROME_ENCRYPTION_PREFIX = Buffer.from("v10");
const CHROME_HOST_HASH_LENGTH = 32;

const ChromeLocalState = Schema.Struct({
  profile: Schema.Struct({
    last_used: Schema.optional(Schema.String),
    info_cache: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

const ChromeCookieRow = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  path: Schema.String,
  expires_utc: Schema.BigInt,
  is_secure: Schema.BigInt,
  is_httponly: Schema.BigInt,
  has_expires: Schema.BigInt,
  samesite: Schema.BigInt,
});

type ChromeCookieRow = typeof ChromeCookieRow.Type;

export interface ChromeCookieImport {
  readonly profileName: string;
  readonly cookies: ReadonlyArray<CookiesSetDetails>;
}

export class ChromeCookieImportError extends Schema.TaggedErrorClass<ChromeCookieImportError>()(
  "ChromeCookieImportError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const chromeExpiryToUnixSeconds = (expiresUtc: bigint): number =>
  Number(expiresUtc / 1_000_000n - CHROME_EPOCH_OFFSET_SECONDS);

const matchesImportedDomain = (host: string): boolean =>
  CHROME_COOKIE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

export function decryptChromeCookie(
  row: Pick<ChromeCookieRow, "encrypted_value" | "host_key" | "value">,
  key: Buffer,
  databaseVersion: number,
): string | null {
  if (row.value.length > 0) return row.value;
  const encrypted = Buffer.from(row.encrypted_value);
  if (
    encrypted.length <= CHROME_ENCRYPTION_PREFIX.length ||
    !encrypted.subarray(0, CHROME_ENCRYPTION_PREFIX.length).equals(CHROME_ENCRYPTION_PREFIX)
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(CHROME_ENCRYPTION_PREFIX.length)),
      decipher.final(),
    ]);

    if (databaseVersion < 24) return plaintext.toString("utf8");
    if (plaintext.length < CHROME_HOST_HASH_LENGTH) return null;
    const expectedHostHash = createHash("sha256").update(row.host_key).digest();
    if (!plaintext.subarray(0, CHROME_HOST_HASH_LENGTH).equals(expectedHostHash)) return null;
    return plaintext.subarray(CHROME_HOST_HASH_LENGTH).toString("utf8");
  } catch {
    return null;
  }
}

function toElectronCookie(row: ChromeCookieRow, value: string): CookiesSetDetails | null {
  if (!matchesImportedDomain(row.host_key)) return null;
  const host = row.host_key.replace(/^\./, "");
  if (host.length === 0 || row.name.length === 0) return null;

  const sameSite = row.samesite === 1n ? "lax" : row.samesite === 2n ? "strict" : "unspecified";
  const cookie: CookiesSetDetails = {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || "/",
    secure: row.is_secure === 1n,
    httpOnly: row.is_httponly === 1n,
    sameSite,
    url: `${row.is_secure === 1n ? "https" : "http"}://${host}${row.path || "/"}`,
  };
  if (row.has_expires === 1n) {
    const expirationDate = chromeExpiryToUnixSeconds(row.expires_utc);
    if (expirationDate > 0) cookie.expirationDate = expirationDate;
  }
  return cookie;
}

export class ChromeCookieImporter extends Context.Service<
  ChromeCookieImporter,
  {
    readonly importLastUsedProfile: () => Effect.Effect<
      ChromeCookieImport,
      ChromeCookieImportError
    >;
  }
>()("@t3tools/desktop/preview/ChromeCookieImporter") {}

export const make = Effect.gen(function* ChromeCookieImporterMake() {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const importLastUsedProfile = Effect.fn("ChromeCookieImporter.importLastUsedProfile")(
    function* () {
      if (process.platform !== "darwin") {
        return yield* new ChromeCookieImportError({
          detail: "Chrome cookie import is currently available on macOS only.",
          cause: null,
        });
      }

      const localState = yield* fileSystem.readFileString(CHROME_LOCAL_STATE).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ChromeLocalState))),
        Effect.mapError(
          (cause) =>
            new ChromeCookieImportError({
              detail: "Google Chrome profiles could not be read.",
              cause,
            }),
        ),
      );
      const profileId =
        localState.profile.last_used &&
        localState.profile.last_used in localState.profile.info_cache
          ? localState.profile.last_used
          : "Default";
      const profileInfo = localState.profile.info_cache[profileId];
      const profileName =
        typeof profileInfo === "object" &&
        profileInfo !== null &&
        "name" in profileInfo &&
        typeof profileInfo.name === "string"
          ? profileInfo.name
          : profileId;

      const password = yield* spawner
        .string(
          ChildProcess.make("/usr/bin/security", [
            "find-generic-password",
            "-w",
            "-s",
            "Chrome Safe Storage",
            "-a",
            "Chrome",
          ]),
        )
        .pipe(
          Effect.map(String.trim),
          Effect.mapError(
            (cause) =>
              new ChromeCookieImportError({
                detail: "Access to Chrome Safe Storage was denied or unavailable.",
                cause,
              }),
          ),
        );
      const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
      const cookieDatabasePath = `${CHROME_ROOT}/${profileId}/Cookies`;

      const cookieRows = yield* Effect.try({
        try: () => {
          const database = new DatabaseSync(cookieDatabasePath, { readOnly: true });
          try {
            const versionRow = database
              .prepare("SELECT value FROM meta WHERE key = 'version'")
              .get() as { value?: string } | undefined;
            const databaseVersion = Number(versionRow?.value ?? 0);
            const statement = database.prepare(`
              SELECT host_key, name, value, encrypted_value, path, expires_utc,
                     is_secure, is_httponly, has_expires, samesite
              FROM cookies
              WHERE top_frame_site_key = ''
                AND (${CHROME_COOKIE_DOMAINS.map(() => "(host_key = ? OR host_key LIKE ?)").join(
                  " OR ",
                )})
            `);
            statement.setReadBigInts(true);
            const parameters = CHROME_COOKIE_DOMAINS.flatMap((domain) => [domain, `%.${domain}`]);
            return {
              databaseVersion,
              rows: statement.all(...parameters),
            };
          } finally {
            database.close();
          }
        },
        catch: (cause) =>
          new ChromeCookieImportError({
            detail: "Chrome cookies could not be read. Close Chrome and try again if it is busy.",
            cause,
          }),
      });
      const cookies = yield* Effect.forEach(
        cookieRows.rows,
        (unknownRow) =>
          Schema.decodeUnknownEffect(ChromeCookieRow)(unknownRow).pipe(
            Effect.mapError(
              (cause) =>
                new ChromeCookieImportError({
                  detail: "Chrome returned an unsupported cookie record.",
                  cause,
                }),
            ),
            Effect.map((row) => {
              const value = decryptChromeCookie(row, key, cookieRows.databaseVersion);
              if (value === null) return [];
              const cookie = toElectronCookie(row, value);
              return cookie ? [cookie] : [];
            }),
          ),
        { concurrency: 8 },
      ).pipe(Effect.map((groups) => groups.flat()));

      return { profileName, cookies };
    },
  );

  return ChromeCookieImporter.of({ importLastUsedProfile });
});

export const layer = Layer.effect(ChromeCookieImporter, make);
