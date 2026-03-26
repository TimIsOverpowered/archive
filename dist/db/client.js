"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClient = getClient;
exports.createClient = createClient;
exports.closeClient = closeClient;
exports.closeAllClients = closeAllClients;
const streamer_1 = require("../../generated/streamer");
const clients = new Map();
function getClient(streamerId) {
    return clients.get(streamerId);
}
async function createClient(config) {
    if (clients.has(config.id))
        return clients.get(config.id);
    const connectionLimit = config.database.connectionLimit || 5;
    const urlWithParams = `${config.database.url}${config.database.url.includes('?') ? '&' : '?'}connection_limit=${connectionLimit}`;
    const client = new streamer_1.PrismaClient({ datasourceUrl: urlWithParams });
    await client.$connect();
    clients.set(config.id, client);
    return client;
}
async function closeClient(streamerId) {
    const client = clients.get(streamerId);
    if (client) {
        await client.$disconnect();
        clients.delete(streamerId);
    }
}
async function closeAllClients() {
    for (const [streamerId, client] of clients.entries()) {
        try {
            await client.$disconnect();
        }
        catch { }
        clients.delete(streamerId);
    }
}
process.on('SIGTERM', () => closeAllClients());
process.on('SIGINT', () => closeAllClients());
//# sourceMappingURL=client.js.map