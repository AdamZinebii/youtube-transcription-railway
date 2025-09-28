import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

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
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase credentials not found. Storage features disabled.');
}

export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

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
} | null> {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Commande yt-dlp pour récupérer les métadonnées en JSON
    const command = `yt-dlp --print-json --no-download "${youtubeUrl}"`;
    const { stdout } = await execAsync(command);
    
    const metadata = JSON.parse(stdout);
    
    return {
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
        undefined
    };
  } catch (error) {
    console.error('❌ Failed to get YouTube metadata:', error);
    return null;
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
 * Mettre à jour le statut d'une vidéo
 */
export async function updateVideoStatus(jobId: string, status: 'Upload' | 'Ingestion' | 'Ready'): Promise<boolean> {
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
        transcription_file_path: metadata.transcriptionFilePath,
        transcription_text: metadata.transcriptionText,
        language: metadata.language,
        segments_count: metadata.segmentsCount,
        transcription_model: metadata.transcriptionModel,
        openai_tokens_used: metadata.openaiTokensUsed,
        file_size_bytes: metadata.fileSizeBytes,
        status: 'Ready', // Final status
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
