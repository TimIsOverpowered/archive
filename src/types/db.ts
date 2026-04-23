import type { Selectable } from 'kysely';
import type { VodsTable } from '../db/streamer-types.js';
export type VodRecord = Selectable<VodsTable>;
