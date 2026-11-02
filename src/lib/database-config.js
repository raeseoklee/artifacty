import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Credentials are carried only in memory and must never appear in status output.
export function databaseConfiguration(options = {}, env = process.env) {
  const provided = options.database;
  if (provided?.kind === "sqlite") return { kind: "sqlite" };
  if (provided && provided.kind !== "postgres") throw invalid("Unsupported database backend");
  const explicit = Object.hasOwn(options, "databaseUrl");
  const value = provided?.connectionString ?? (explicit ? options.databaseUrl : env.ARTIFACTY_DATABASE_URL);
  if (value == null || value === "") return { kind: "sqlite" };
  let url;
  try { url = new URL(value); } catch { throw invalid("ARTIFACTY_DATABASE_URL must be a PostgreSQL connection URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/" || url.hash) throw invalid("ARTIFACTY_DATABASE_URL must identify a PostgreSQL database");
  const schema = options.databaseSchema ?? provided?.schema ?? env.ARTIFACTY_DATABASE_SCHEMA ?? "artifacty";
  if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || ["public", "information_schema"].includes(schema) || schema.startsWith("pg_")) throw invalid("PostgreSQL schema must be a dedicated lowercase identifier");
  const timeoutMs = Number(options.databaseTimeoutMs ?? provided?.timeoutMs ?? env.ARTIFACTY_DATABASE_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw invalid("PostgreSQL timeout must be an integer from 1000 to 120000 milliseconds");
  return { kind: "postgres", connectionString: url.href, schema, timeoutMs };
}

export function isPostgresStore(input = {}) {
  if (readDatabaseBackend(input.home || process.env.ARTIFACTY_HOME || path.join(homedir(), ".artifacty")) === "postgres") return true;
  if (input.databaseBackend) return input.databaseBackend === "postgres";
  return databaseConfiguration(input).kind === "postgres";
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_DATABASE_CONFIG", statusCode: 400 });
}

export function readDatabaseBackend(home) {
  return existsSync(path.join(path.resolve(home), ".postgres-store-id")) ? "postgres" : "sqlite";
}
