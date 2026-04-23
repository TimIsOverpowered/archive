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

export function expectFirst<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('Expected at least one item, got 0');
  return items[0] as T;
}
