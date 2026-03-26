"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.childLogger = childLogger;
const pino_1 = __importDefault(require("pino"));
const logLevel = process.env.LOG_LEVEL || 'info';
exports.logger = (0, pino_1.default)({
    level: logLevel,
    customLevels: {
        metric: 35, // Between info and warn
    },
    mixin: () => ({
        service: 'archive-api',
        env: process.env.NODE_ENV || 'development',
    }),
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            customLevels: {
                metric: '📊',
            },
        },
    },
});
function childLogger(context) {
    return exports.logger.child(context);
}
//# sourceMappingURL=logger.js.map