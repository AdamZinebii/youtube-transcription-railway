import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';

// Types pour la base de données
export interface VideoMetadata {
  jobId: string;
  youtubeUrl: string;
  videoId: string;
  title: string;
  userId: string; // ID de l'utilisateur ChatGenius
  description?: string;
  views?: number;
  likes?: number;
  channelName?: string;
  channelUrl?: string;
  durationSeconds?: number;
  uploadDate?: string;
  thumbnailUrl?: string; // URL from Supabase storage
  transcriptionFilePath: string;
  transcriptionText: string;
  language?: string;
  segmentsCount?: number;
  transcriptionModel: string;
  openaiTokensUsed?: number;
  fileSizeBytes: number;
}

// Configuration Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase credentials not found. Storage features disabled.');
}

export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

/**
 * Check if URL is a YouTube channel URL
 */
export function isChannelUrl(url: string): boolean {
  const channelPatterns = [
    /youtube\.com\/@[^\/]+/,           // @channelname format
    /youtube\.com\/c\/[^\/]+/,         // /c/channelname format  
    /youtube\.com\/channel\/[^\/]+/,   // /channel/UCxxxxx format
    /youtube\.com\/user\/[^\/]+/,      // /user/username format (legacy)
  ];
  
  return channelPatterns.some(pattern => pattern.test(url));
}

/**
 * Extract last 10 video URLs from a YouTube channel
 */
export async function getChannelVideos(channelUrl: string, limit: number = 10): Promise<string[] | null> {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    console.log(`🔍 Extracting ${limit} latest videos from channel: ${channelUrl}`);
    
    // Ensure we're looking at the videos page
    let videosUrl = channelUrl;
    if (!channelUrl.includes('/videos')) {
      videosUrl = `${channelUrl}/videos`;
    }

    // Use the command provided by the user
    const command = `yt-dlp --flat-playlist -j "${videosUrl}" | head -n ${limit} | jq -r '.url'`;
    
    const { stdout } = await execAsync(command, { 
      maxBuffer: 5 * 1024 * 1024, // 5MB buffer
      timeout: 60000 // 1 minute timeout
    });

    const videoIds = stdout.trim().split('\n').filter((id: string) => id && id !== 'null');
    
    // Convert video IDs to full URLs
    const fullUrls = videoIds.map((id: string) => {
      if (id.startsWith('http')) {
        return id;
      } else {
        return `https://www.youtube.com/watch?v=${id}`;
      }
    });

    console.log(`✅ Found ${fullUrls.length} videos from channel`);
    return fullUrls.length > 0 ? fullUrls : null;

  } catch (error) {
    console.error('❌ Failed to extract channel videos:', error);
    return null;
  }
}

/**
 * Extraire les métadonnées d'une vidéo YouTube avec yt-dlp
 */
export async function getYouTubeMetadata(youtubeUrl: string): Promise<{
  videoId: string;
  title: string;
  description?: string;
  views?: number;
  likes?: number;
  channelName?: string;
  channelUrl?: string;
  durationSeconds?: number;
  uploadDate?: string;
  thumbnail?: string;
} | null> {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Option 1: Use specific print format to get only essential metadata
    const specificFields = [
      'id', 'title', 'description', 'view_count', 'like_count', 
      'uploader', 'channel', 'uploader_url', 'channel_url', 
      'duration', 'upload_date', 'thumbnail'
    ].join(',');
    
    const command = `yt-dlp --skip-download --print-json "${youtubeUrl}"`;
    
    // Increase maxBuffer to 10MB and add timeout
    const { stdout } = await execAsync(command, { 
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 30000 // 30 second timeout
    });
    
    const metadata = JSON.parse(stdout);
    
    const result = {
      videoId: metadata.id,
      title: metadata.title,
      description: metadata.description?.substring(0, 1000), // Limiter à 1000 caractères
      views: metadata.view_count,
      likes: metadata.like_count,
      channelName: metadata.uploader || metadata.channel,
      channelUrl: metadata.uploader_url || metadata.channel_url,
      durationSeconds: metadata.duration,
      uploadDate: metadata.upload_date ? 
        `${metadata.upload_date.substring(0,4)}-${metadata.upload_date.substring(4,6)}-${metadata.upload_date.substring(6,8)}` : 
        undefined,
      thumbnail: metadata.thumbnail
    };
    
    console.log(`📸 Primary method - Thumbnail URL: ${result.thumbnail ? 'Found' : 'Not found'} - ${result.thumbnail?.substring(0, 50)}...`);
    return result;
  } catch (error) {
    console.error('❌ Failed to get YouTube metadata:', error);
    
    // Fallback: Try with minimal output format
    try {
      console.log('🔄 Trying fallback method for metadata extraction...');
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Use print template to get only specific fields we need
      const command = `yt-dlp --skip-download --print "%(id)s|||%(title)s|||%(uploader)s|||%(view_count)s|||%(like_count)s|||%(duration)s|||%(thumbnail)s|||%(upload_date)s|||%(description)s" "${youtubeUrl}"`;
      
      const { stdout } = await execAsync(command, { 
        maxBuffer: 1024 * 1024, // 1MB buffer should be enough for simple output
        timeout: 30000
      });
      
      const parts = stdout.trim().split('|||');
      if (parts.length >= 6) {
        const result = {
          videoId: parts[0] || '',
          title: parts[1] || 'Unknown Title',
          channelName: parts[2] || undefined,
          views: parts[3] ? parseInt(parts[3]) : undefined,
          likes: parts[4] ? parseInt(parts[4]) : undefined,
          durationSeconds: parts[5] ? parseInt(parts[5]) : undefined,
          thumbnail: parts[6] || undefined,
          uploadDate: parts[7] && parts[7] !== 'NA' ? 
            `${parts[7].substring(0,4)}-${parts[7].substring(4,6)}-${parts[7].substring(6,8)}` : 
            undefined,
          description: parts[8] ? parts[8].substring(0, 1000) : undefined
        };
        
        console.log(`📸 Fallback method - Thumbnail URL: ${result.thumbnail ? 'Found' : 'Not found'} - ${result.thumbnail?.substring(0, 50)}...`);
        console.log(`🔍 Fallback method - Parts array length: ${parts.length}, Part[6]: ${parts[6]}`);
        return result;
      }
      
      return null;
    } catch (fallbackError) {
      console.error('❌ Fallback metadata extraction also failed:', fallbackError);
      return null;
    }
  }
}

/**
 * Uploader la transcription vers Supabase Storage
 */
export async function uploadTranscriptionToSupabase(
  jobId: string,
  transcriptionData: any,
  transcriptionText: string
): Promise<string | null> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping upload');
    return null;
  }

  try {
    // Créer le fichier JSON de transcription
    const transcriptionJson = JSON.stringify(transcriptionData, null, 2);
    const fileName = `${jobId}_transcript.json`;
    
    // Upload vers le bucket 'transcriptions'
    const { data, error } = await supabase.storage
      .from('transcriptions')
      .upload(fileName, transcriptionJson, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      console.error('❌ Supabase upload error:', error);
      return null;
    }

    // Retourner l'URL publique
    const { data: urlData } = supabase.storage
      .from('transcriptions')
      .getPublicUrl(fileName);

    console.log('✅ Transcription uploaded to Supabase:', urlData.publicUrl);
    return urlData.publicUrl;
    
  } catch (error) {
    console.error('❌ Upload to Supabase failed:', error);
    return null;
  }
}

/**
 * Download and upload thumbnail to Supabase Storage using yt-dlp
 */
export async function uploadThumbnailToSupabase(
  jobId: string,
  youtubeUrl: string,
  thumbnailUrl?: string
): Promise<string | null> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured');
    return null;
  }

  try {
    console.log(`📸 Downloading thumbnail for job: ${jobId}`);
    
    // Method 1: Use yt-dlp to download thumbnail directly (more reliable)
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const tempDir = `/tmp/${jobId}_thumb`;
    const fs = require('fs');
    
    // Create temporary directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Download thumbnail using yt-dlp
    const command = `yt-dlp --write-thumbnail --skip-download --output "${tempDir}/thumbnail.%(ext)s" "${youtubeUrl}"`;
    
    try {
      await execAsync(command, { timeout: 30000 });
      
      // Find the downloaded thumbnail file
      const files = fs.readdirSync(tempDir);
      const thumbnailFile = files.find((file: string) => file.startsWith('thumbnail.'));
      
      if (!thumbnailFile) {
        throw new Error('Thumbnail file not found after download');
      }
      
      const thumbnailPath = `${tempDir}/${thumbnailFile}`;
      const thumbnailBuffer = fs.readFileSync(thumbnailPath);
      const extension = thumbnailFile.split('.').pop() || 'jpg';
      const fileName = `${jobId}_thumbnail.${extension}`;
      
      // Upload to thumbnails bucket
      const { data, error } = await supabase.storage
        .from('thumbnails')
        .upload(fileName, thumbnailBuffer, {
          contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
          upsert: true
        });

      if (error) {
        throw error;
      }

      // Cleanup temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('thumbnails')
        .getPublicUrl(fileName);

      console.log('✅ Thumbnail uploaded to Supabase via yt-dlp:', urlData.publicUrl);
      return urlData.publicUrl;
      
    } catch (ytdlpError) {
      console.log('⚠️ yt-dlp thumbnail download failed, trying HTTP method...');
      
      // Cleanup temp directory if it exists
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      
      // Fallback to HTTP download if thumbnail URL is provided
      if (!thumbnailUrl) {
        throw new Error('No thumbnail URL available for HTTP fallback');
      }
      
      const thumbnailBuffer = await downloadThumbnail(thumbnailUrl);
      if (!thumbnailBuffer) {
        throw new Error('Failed to download thumbnail via HTTP');
      }

      // Get file extension from URL or default to jpg
      const urlParts = new URL(thumbnailUrl);
      const pathParts = urlParts.pathname.split('.');
      const extension = pathParts.length > 1 ? pathParts[pathParts.length - 1] : 'jpg';
      const fileName = `${jobId}_thumbnail.${extension}`;
      
      // Upload to thumbnails bucket
      const { data, error } = await supabase.storage
        .from('thumbnails')
        .upload(fileName, thumbnailBuffer, {
          contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
          upsert: true
        });

      if (error) {
        throw error;
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('thumbnails')
        .getPublicUrl(fileName);

      console.log('✅ Thumbnail uploaded to Supabase via HTTP fallback:', urlData.publicUrl);
      return urlData.publicUrl;
    }
    
  } catch (error) {
    console.error('❌ Thumbnail upload failed:', error);
    return null;
  }
}

/**
 * Download thumbnail from URL
 */
async function downloadThumbnail(url: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    
    client.get(url, (response) => {
      if (response.statusCode !== 200) {
        console.error(`❌ Failed to download thumbnail: HTTP ${response.statusCode}`);
        resolve(null);
        return;
      }

      const data: Buffer[] = [];
      
      response.on('data', (chunk: Buffer) => {
        data.push(chunk);
      });
      
      response.on('end', () => {
        const buffer = Buffer.concat(data);
        console.log(`✅ Downloaded thumbnail: ${buffer.length} bytes`);
        resolve(buffer);
      });
      
    }).on('error', (error) => {
      console.error('❌ Error downloading thumbnail:', error);
      resolve(null);
    });
  });
}

/**
 * Créer l'enregistrement initial avec statut "Upload"
 */
export async function createInitialVideoRecord(jobId: string, youtubeUrl: string, userId: string): Promise<string | null> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping database save');
    return null;
  }

  try {
    // Extract video ID from URL for the record
    const videoIdMatch = youtubeUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : jobId;

    const { data, error } = await supabase
      .from('video_transcriptions')
      .insert({
        job_id: jobId,
        youtube_url: youtubeUrl,
        video_id: videoId,
        title: 'Processing...', // Placeholder title
        user_id: userId,
        transcription_file_path: '', // Will be filled later
        transcription_text: '', // Will be filled later
        status: 'Upload',
        file_size_bytes: 0 // Will be filled later
      })
      .select('id')
      .single();

    if (error) {
      console.error('❌ Failed to create initial video record:', error);
      return null;
    }

    console.log('✅ Initial video record created with Upload status');
    return data.id;
    
  } catch (error) {
    console.error('❌ Create initial video record failed:', error);
    return null;
  }
}

/**
 * Update initial video record with metadata and thumbnail during Upload status
 */
export async function updateInitialVideoMetadata(
  jobId: string, 
  metadata: {
    title: string;
    description?: string;
    views?: number;
    likes?: number;
    channelName?: string;
    channelUrl?: string;
    durationSeconds?: number;
    uploadDate?: string;
    thumbnailUrl?: string;
  }
): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping metadata update');
    return false;
  }

  try {
    console.log(`🔄 Updating initial metadata for job_id: ${jobId}`);
    
    const { error } = await supabase
      .from('video_transcriptions')
      .update({
        title: metadata.title,
        description: metadata.description,
        views: metadata.views,
        likes: metadata.likes,
        channel_name: metadata.channelName,
        channel_url: metadata.channelUrl,
        duration_seconds: metadata.durationSeconds,
        upload_date: metadata.uploadDate,
        thumbnail_url: metadata.thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    if (error) {
      console.error('❌ Failed to update initial metadata:', error);
      return false;
    }

    console.log(`✅ Initial metadata updated successfully for job: ${jobId}`);
    return true;
    
  } catch (error) {
    console.error('❌ Update initial metadata failed:', error);
    return false;
  }
}

/**
 * Mettre à jour le statut d'une vidéo
 */
export async function updateVideoStatus(jobId: string, status: 'Upload' | 'Ingestion' | 'Processing' | 'Ready'): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping status update');
    return false;
  }

  try {
    const { error } = await supabase
      .from('video_transcriptions')
      .update({ 
        status,
        updated_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    if (error) {
      console.error('❌ Failed to update video status:', error);
      return false;
    }

    console.log(`✅ Video status updated to: ${status}`);
    return true;
    
  } catch (error) {
    console.error('❌ Update video status failed:', error);
    return false;
  }
}

/**
 * Sauvegarder les métadonnées dans la table Supabase
 */
export async function saveVideoMetadataToSupabase(metadata: VideoMetadata): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping database save');
    return false;
  }

  try {
    console.log(`🔄 Updating video metadata for job_id: ${metadata.jobId}`);
    
    const { data, error } = await supabase
      .from('video_transcriptions')
      .update({
        title: metadata.title,
        description: metadata.description,
        views: metadata.views,
        likes: metadata.likes,
        channel_name: metadata.channelName,
        channel_url: metadata.channelUrl,
        duration_seconds: metadata.durationSeconds,
        upload_date: metadata.uploadDate,
        thumbnail_url: metadata.thumbnailUrl,
        transcription_file_path: metadata.transcriptionFilePath,
        transcription_text: metadata.transcriptionText,
        language: metadata.language,
        segments_count: metadata.segmentsCount,
        transcription_model: metadata.transcriptionModel,
        openai_tokens_used: metadata.openaiTokensUsed,
        file_size_bytes: metadata.fileSizeBytes,
        status: 'Processing', // Set to Processing, will be updated to Ready after Edge Functions
        updated_at: new Date().toISOString()
      })
      .eq('job_id', metadata.jobId)
      .select(); // Add select to return the updated data

    if (error) {
      console.error('❌ Supabase database error:', error);
      return false;
    }

    if (!data || data.length === 0) {
      console.error(`❌ No record found with job_id: ${metadata.jobId} for UPDATE`);
      
      // Try to find existing record for debugging
      const { data: existingRecord } = await supabase
        .from('video_transcriptions')
        .select('job_id, status, user_id')
        .eq('job_id', metadata.jobId)
        .single();
        
      console.log('🔍 Existing record check:', existingRecord);
      return false;
    }

    console.log(`✅ Video metadata updated successfully. Records affected: ${data.length}`);
    console.log('✅ Status updated to: Ready');
    return true;
    
  } catch (error) {
    console.error('❌ Save to Supabase database failed:', error);
    return false;
  }
}

/**
 * Rechercher des transcriptions dans la base
 */
export async function searchTranscriptions(query: string, limit: number = 10) {
  if (!supabase) {
    return { data: [], error: 'Supabase not configured' };
  }

  const { data, error } = await supabase
    .from('video_transcriptions')
    .select('*')
    .or(`title.ilike.%${query}%, description.ilike.%${query}%, transcription_text.ilike.%${query}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  return { data, error };
}

/**
 * Obtenir une transcription par job_id
 */
export async function getTranscriptionByJobId(jobId: string) {
  if (!supabase) {
    return { data: null, error: 'Supabase not configured' };
  }

  const { data, error } = await supabase
    .from('video_transcriptions')
    .select('*')
    .eq('job_id', jobId)
    .single();

  return { data, error };
}

/**
 * Call transcript-segmenter Supabase Edge Function
 */
export async function callTranscriptSegmenter(videoTranscriptionId: string): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping transcript segmentation');
    return false;
  }

  try {
    console.log(`🧠 Calling transcript-segmenter for video: ${videoTranscriptionId}`);
    
    const { data, error } = await supabase.functions.invoke('transcript-segmenter', {
      body: { video_transcription_id: videoTranscriptionId }
    });

    if (error) {
      console.error('❌ Error calling transcript-segmenter:', error);
      return false;
    }

    console.log('✅ Transcript segmentation completed:', data?.metadata);
    return true;

  } catch (error) {
    console.error('❌ Transcript segmentation failed:', error);
    return false;
  }
}

/**
 * Call embed-video Supabase Edge Function
 */
export async function callEmbedVideo(videoTranscriptionId: string): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping video embedding');
    return false;
  }

  try {
    console.log(`🔍 Calling embed-video for video: ${videoTranscriptionId}`);
    
    const { data, error } = await supabase.functions.invoke('embed-video', {
      body: { video_transcription_id: videoTranscriptionId }
    });

    if (error) {
      console.error('❌ Error calling embed-video:', error);
      return false;
    }

    console.log('✅ Video embedding completed:', data?.embedding_length);
    return true;

  } catch (error) {
    console.error('❌ Video embedding failed:', error);
    return false;
  }
}

/**
 * Call embed-segment Supabase Edge Function for a specific video
 */
export async function callEmbedSegments(videoTranscriptionId: string): Promise<boolean> {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured, skipping segment embedding');
    return false;
  }

  try {
    console.log(`🔍 Calling embed-segment for video: ${videoTranscriptionId}`);
    
    const { data, error } = await supabase.functions.invoke('embed-segment', {
      body: { 
        video_transcription_id: videoTranscriptionId,
        batch_mode: true,
        batch_limit: 50 // Process all segments for this video
      }
    });

    if (error) {
      console.error('❌ Error calling embed-segment:', error);
      return false;
    }

    console.log(`✅ Segment embedding completed: ${data?.successful}/${data?.processed} segments`);
    return true;

  } catch (error) {
    console.error('❌ Segment embedding failed:', error);
    return false;
  }
}

/**
 * Process video through all AI enhancement functions
 */
export async function processVideoThroughAIFunctions(videoTranscriptionId: string, jobId: string): Promise<boolean> {
  console.log(`🚀 Starting AI processing pipeline for video: ${videoTranscriptionId}`);
  
  try {
    // Step 1: Segment the transcript using Claude
    const segmentationSuccess = await callTranscriptSegmenter(videoTranscriptionId);
    if (!segmentationSuccess) {
      console.error('❌ Transcript segmentation failed, stopping pipeline');
      return false;
    }

    // Step 2: Create video-level embeddings
    const videoEmbedSuccess = await callEmbedVideo(videoTranscriptionId);
    if (!videoEmbedSuccess) {
      console.error('❌ Video embedding failed, stopping pipeline');
      return false;
    }

    // Step 3: Create segment-level embeddings
    const segmentEmbedSuccess = await callEmbedSegments(videoTranscriptionId);
    if (!segmentEmbedSuccess) {
      console.error('❌ Segment embedding failed, stopping pipeline');
      return false;
    }

    // Step 4: Update final status to Ready
    await updateVideoStatus(jobId, 'Ready');
    
    console.log('🎉 AI processing pipeline completed successfully!');
    return true;

  } catch (error) {
    console.error('❌ AI processing pipeline failed:', error);
    return false;
  }
}
