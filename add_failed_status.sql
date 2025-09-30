-- Add 'Failed' status to the video_transcriptions status constraint
-- This allows videos to be marked as failed when errors occur during processing

ALTER TABLE video_transcriptions
DROP CONSTRAINT IF EXISTS video_transcriptions_status_check;

ALTER TABLE video_transcriptions
ADD CONSTRAINT video_transcriptions_status_check 
CHECK (status = ANY (ARRAY['Upload'::text, 'Ingestion'::text, 'Processing'::text, 'Ready'::text, 'Failed'::text]));

-- Optional: Add error_message column to store failure details
ALTER TABLE video_transcriptions
ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Create index on status for efficient filtering
CREATE INDEX IF NOT EXISTS idx_video_transcriptions_status_failed 
ON video_transcriptions(status) 
WHERE status = 'Failed';

