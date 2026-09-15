export interface MidwayCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
}

const HTTP_ONLY_PREFIX = "#HttpOnly_";

export function parseMidwayCookieJar(raw: string): ReadonlyArray<MidwayCookie> {
  const cookies: MidwayCookie[] = [];

  for (const rawLine of raw.split("\n")) {
    const httpOnly = rawLine.startsWith(HTTP_ONLY_PREFIX);
    const line = httpOnly ? rawLine.slice(HTTP_ONLY_PREFIX.length) : rawLine;
    if (line.startsWith("#") || line.trim() === "") continue;

    const [domain, , path, secureField, expiresField, name, value] = line.split("\t");
    if (!domain || !name || !value) continue;

    const secure = /^true$/iu.test(secureField ?? "");
    const cookiePath = path || "/";
    const host = domain.replace(/^\./u, "");
    const expires = Number(expiresField);

    cookies.push({
      url: `${secure ? "https" : "http"}://${host}${cookiePath}`,
      name,
      value,
      path: cookiePath,
      secure,
      httpOnly,
      ...(name.startsWith("__Host-") ? {} : { domain }),
      ...(Number.isFinite(expires) && expires > 0 ? { expirationDate: expires } : {}),
    });
  }

  return cookies;
}
