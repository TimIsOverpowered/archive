-- Add foreign key constraint from chat_messages to vods with cascade delete
ALTER TABLE chat_messages 
ADD CONSTRAINT chat_messages_vod_id_fkey 
FOREIGN KEY (vod_id) REFERENCES vods(id) ON DELETE CASCADE;
