export function buildPgBouncerUrl(pgbouncerUrl: string, dbName: string): string {
  const url = new URL(pgbouncerUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
