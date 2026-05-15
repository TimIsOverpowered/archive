import { Cache } from '../../constants.js';

export interface PaginationOptions {
  page?: number;
  limit?: number;
  maxLimit?: number;
  maxPage?: number;
}

export function buildPagination(opts: PaginationOptions): { page: number; offset: number; limit: number } {
  const maxPage = Math.max(1, opts.maxPage ?? Cache.MAX_PAGES);
  const page = Math.max(1, Math.min(maxPage, opts.page ?? 1));
  const maxLimit = opts.maxLimit ?? 100;
  const limit = Math.min(maxLimit, Math.max(1, opts.limit ?? 20));
  const offset = (page - 1) * limit;

  return { page, offset, limit };
}
