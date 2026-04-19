/**
 * Global TypeScript type declarations for shared state across modules.
 */

declare module 'puppeteer-extra-plugin-click-and-wait' {
  const plugin: () => PuppeteerExtraPlugin;
  export default plugin;
}
