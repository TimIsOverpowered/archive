export const platformConstraintStrategy = {
  name: 'platform' as const,
  storage() {
    const handlers: Record<string, unknown> = {};
    return {
      get(value: string): unknown {
        return handlers[value] || null;
      },
      set(value: string, store: unknown) {
        handlers[value] = store;
      },
    };
  },
  deriveConstraint(request: { params?: Record<string, string> }) {
    return request.params?.platform;
  },
  mustMatchWhenDerived: true,
  validate(value: string) {
    return ['twitch', 'kick'].includes(value);
  },
};
