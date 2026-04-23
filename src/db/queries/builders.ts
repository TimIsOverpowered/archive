import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';

export interface PaginationOptions {
  page?: number;
  limit?: number;
  maxLimit?: number;
}

export function buildPagination(opts: PaginationOptions): { page: number; offset: number; limit: number } {
  const page = Math.max(1, opts.page ?? 1);
  const maxLimit = opts.maxLimit ?? 100;
  const limit = Math.min(maxLimit, Math.max(1, opts.limit ?? 20));
  const offset = (page - 1) * limit;

  return { page, offset, limit };
}

export type WhereFn<T extends Record<string, unknown>> = (
  eb: ExpressionBuilder<T, keyof T & string>
) => Expression<SqlBool>;

export function andWhere<T extends Record<string, unknown>>(
  eb: ExpressionBuilder<T, keyof T & string>,
  conditions: WhereFn<T>[]
): Expression<SqlBool> {
  return eb.and(conditions.map((fn) => fn(eb)));
}

export function orWhere<T extends Record<string, unknown>>(
  eb: ExpressionBuilder<T, keyof T & string>,
  conditions: WhereFn<T>[]
): Expression<SqlBool> {
  return eb.or(conditions.map((fn) => fn(eb)));
}

export function safeFirst<T>(items: readonly T[]): T | undefined {
  return items[0];
}

export function expectFirst<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('Expected at least one item, got 0');
  return items[0] as T;
}

export function toNullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result = {} as Partial<T>;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const val = obj[key];
    if (val !== undefined && val !== null) {
      result[key] = val;
    }
  }
  return result;
}
