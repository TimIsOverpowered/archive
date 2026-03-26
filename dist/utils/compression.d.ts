type CompressionAlgorithm = 'brotli' | 'gzip' | 'none';
export declare function getCompressionAlgorithm(): CompressionAlgorithm;
export declare function compressChatData(data: unknown): Promise<Buffer>;
export declare function decompressChatData(compressed: Buffer): Promise<unknown>;
export declare function estimateCompressionRatio(): number;
export {};
//# sourceMappingURL=compression.d.ts.map