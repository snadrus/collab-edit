/** Prefix used when FiPen and FiGrid are hosted under FiFolders Pages. Legacy prefixes still resolve. */
export function hostBase(): string {
  const path = location.pathname;
  const prefixes = ["/figrid", "/fipen", "/felanumio", "/felarumi"];
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return prefix;
  }
  return "";
}

/** App route, after a Pages 404 redirect (`?spa=`) or the editor prefix. */
export function routePath(): string {
  const spa = new URLSearchParams(location.search).get("spa");
  if (spa) return spa.startsWith("/") ? spa : `/${spa}`;
  const base = hostBase();
  let path = location.pathname;
  if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

/** Keep FiFolders query params (and wire) when the editor moves to a document or book. */
export function withKeptQuery(path: string, hash: string): string {
  const params = new URLSearchParams(location.search);
  params.delete("spa");
  const base = hostBase();
  // Under a Pages prefix only the prefix has an index.html; deep paths 404 before redirecting. Route in the query instead.
  let target = path;
  let query = params.toString();
  if (base && path.startsWith(`${base}/`) && path.length > base.length + 1) {
    target = `${base}/`;
    query = `spa=${encodeURIComponent(path.slice(base.length))}` + (query ? `&${query}` : "");
  }
  return target + (query ? `?${query}` : "") + (hash ? `#${hash}` : "");
}
