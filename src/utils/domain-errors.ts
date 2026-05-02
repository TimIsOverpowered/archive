/**
 * Typed domain error hierarchy for structured error handling.
 *
 * Benefits over generic Error:
 * - instanceof checks in catch blocks (no string matching)
 * - error code attached at throw site, not reconstructed at catch
 * - explicit intent — `TenantNotFoundError` > `new Error('Tenant not found')`
 */

export abstract class DomainError extends Error {
  abstract code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TenantNotFoundError extends DomainError {
  readonly code = 'TENANT_NOT_FOUND';

  constructor(id: string) {
    super(`Tenant not found: ${id}`);
  }
}

export class VodNotFoundError extends DomainError {
  readonly code = 'VOD_NOT_FOUND';

  constructor(vodId: string | number, context?: string) {
    super(context != null && context !== '' ? `VOD not found: ${vodId} (${context})` : `VOD not found: ${vodId}`);
  }
}

export class PlatformNotConfiguredError extends DomainError {
  readonly code = 'PLATFORM_NOT_CONFIGURED';

  constructor(platform: string, context?: string) {
    super(context != null && context !== '' ? `${platform} not configured: ${context}` : `${platform} not configured`);
  }
}

export class ConfigNotConfiguredError extends DomainError {
  readonly code = 'CONFIG_NOT_CONFIGURED';

  constructor(detail: string) {
    super(`${detail} not configured`);
  }
}

export class FileNotFound extends DomainError {
  readonly code = 'FILE_NOT_FOUND';

  constructor(path: string) {
    super(`File not found: ${path}`);
  }
}

export class DownloadAbortedError extends DomainError {
  readonly code = 'DOWNLOAD_ABORTED';

  constructor() {
    super('Download aborted');
  }
}

export class GameNotFoundError extends DomainError {
  readonly code = 'GAME_NOT_FOUND';

  constructor(gameId: number) {
    super(`Game not found: ${gameId}`);
  }
}

export class PlatformNotMainSourceError extends DomainError {
  readonly code = 'PLATFORM_NOT_MAIN_SOURCE';

  constructor(platform: string) {
    super(`${platform} is not configured as the main upload source`);
  }
}

export class RestrictedGameError extends DomainError {
  readonly code = 'RESTRICTED_GAME';

  constructor(gameName: string) {
    super(`Game "${gameName}" is in restricted games list`);
  }
}
