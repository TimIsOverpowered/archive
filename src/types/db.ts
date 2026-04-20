import type { Selectable } from 'kysely';
import type { VodsTable } from '../db/streamer-types';
export type VodRecord = Selectable<VodsTable>;
