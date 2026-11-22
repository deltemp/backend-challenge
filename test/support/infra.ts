// Endpoints of the infrastructure started by docker compose, as seen from the host. Bun loads
// .env automatically, so these follow the same settings as `bun run dev`.

export const infra = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:55432/wagering",
  awsEndpointUrl: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
};

/** The server and credentials of DATABASE_URL, pointed at another database. */
export function databaseUrlFor(databaseName: string): string {
  const url = new URL(infra.databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** host:port of DATABASE_URL, for error messages that must not print the password. */
export function databaseAddress(): string {
  const url = new URL(infra.databaseUrl);
  return `${url.hostname}:${url.port || "5432"}`;
}
