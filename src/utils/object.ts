export function asJsonObject(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}
