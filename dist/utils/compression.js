"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCompressionAlgorithm = getCompressionAlgorithm;
exports.compressChatData = compressChatData;
exports.decompressChatData = decompressChatData;
exports.estimateCompressionRatio = estimateCompressionRatio;
const zlib = __importStar(require("zlib"));
const util_1 = require("util");
const brotliCompress = (0, util_1.promisify)(zlib.brotliCompress);
const brotliDecompress = (0, util_1.promisify)(zlib.brotliDecompress);
const gzipCompress = (0, util_1.promisify)(zlib.gzip);
const gzipDecompress = (0, util_1.promisify)(zlib.gunzip);
const algorithm = (process.env.REDIS_CHAT_COMPRESSION || 'brotli');
const level = parseInt(process.env.REDIS_COMPRESSION_LEVEL || '6', 10);
function getCompressionAlgorithm() {
    return algorithm;
}
async function compressChatData(data) {
    const json = JSON.stringify(data);
    const buffer = Buffer.from(json, 'utf8');
    if (algorithm === 'none') {
        return buffer;
    }
    if (algorithm === 'brotli') {
        return brotliCompress(buffer);
    }
    if (algorithm === 'gzip') {
        return gzipCompress(buffer, { level });
    }
    return buffer;
}
async function decompressChatData(compressed) {
    if (algorithm === 'none') {
        return JSON.parse(compressed.toString('utf8'));
    }
    let decompressed;
    if (algorithm === 'brotli') {
        decompressed = await brotliDecompress(compressed);
    }
    else {
        decompressed = await gzipDecompress(compressed);
    }
    return JSON.parse(decompressed.toString('utf8'));
}
function estimateCompressionRatio() {
    switch (algorithm) {
        case 'brotli':
            return 0.15; // 85% reduction
        case 'gzip':
            return 0.2; // 80% reduction
        case 'none':
            return 1.0;
        default:
            return 1.0;
    }
}
//# sourceMappingURL=compression.js.map