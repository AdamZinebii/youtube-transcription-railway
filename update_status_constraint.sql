-- Update the status check constraint to include the new "Processing" status
ALTER TABLE video_transcriptions 
DROP CONSTRAINT video_transcriptions_status_check;

ALTER TABLE video_transcriptions 
ADD CONSTRAINT video_transcriptions_status_check 
CHECK (status = ANY (ARRAY['Upload'::text, 'Ingestion'::text, 'Processing'::text, 'Ready'::text]));
