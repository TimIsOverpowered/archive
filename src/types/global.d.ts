/**
 * Global TypeScript type declarations for shared state across modules.
 */

declare namespace NodeJS {
  interface Global {
    /** Map of tenantId:platform -> setInterval ID for cleanup during shutdown */
    monitorIntervals?: Map<string, ReturnType<typeof setInterval>>;
  }
}

declare module 'puppeteer-extra-plugin-click-and-wait' {
  const plugin: () => PuppeteerExtraPlugin;
  export default plugin;
}
