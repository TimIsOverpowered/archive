/**
 * Global TypeScript type declarations for shared state across modules.
 */

declare namespace NodeJS {
  interface Global {
    /** Map of streamerId:platform -> setInterval ID for cleanup during shutdown */
    monitorIntervals?: Map<string, ReturnType<typeof setInterval>>;
  }
}


// Puppeteer plugin declaration (no types available)
declare module 'puppeteer-extra-plugin-click-and-wait' {
  function clickAndWaitPlugin(): any;
  export default clickAndWaitPlugin;
}
