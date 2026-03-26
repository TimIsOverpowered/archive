interface PuppeteerHealthStatus {
    status: 'ok' | 'unavailable' | 'high_memory';
    instanceMemoryMb?: number;
}
export declare function checkPuppeteerHealth(): Promise<PuppeteerHealthStatus>;
export declare function clearPuppeteerHealthCache(): void;
export {};
//# sourceMappingURL=puppeteer-health.d.ts.map