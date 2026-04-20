import type {
  ColumnType,
  Generated,
  JSONColumnType,
  Kysely,
  Selectable,
  Insertable,
  Updateable,
  Transaction,
} from 'kysely';

export interface MetaDB {
  tenants: TenantsTable;
  admins: AdminsTable;
}

export interface TenantsTable {
  id: string;
  display_name: string | null;
  twitch: JSONColumnType<Record<string, unknown>> | null;
  youtube: JSONColumnType<Record<string, unknown>> | null;
  kick: JSONColumnType<Record<string, unknown>> | null;
  database_url: string | null;
  settings: JSONColumnType<Record<string, unknown>>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AdminsTable {
  id: Generated<number>;
  username: string;
  api_key: string;
  api_key_hash: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

// Utility types
export type SelectableTenants = Selectable<TenantsTable>;
export type InsertableTenants = Insertable<TenantsTable>;
export type UpdateableTenants = Updateable<TenantsTable>;

export type SelectableAdmins = Selectable<AdminsTable>;
export type InsertableAdmins = Insertable<AdminsTable>;
export type UpdateableAdmins = Updateable<AdminsTable>;

export interface TenantResult {
  id: string;
  displayName: string | null;
  twitch: Record<string, unknown> | null;
  youtube: Record<string, unknown> | null;
  kick: Record<string, unknown> | null;
  databaseUrl: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type MetaDBClient = Kysely<MetaDB> | Transaction<MetaDB>;
