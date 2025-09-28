import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { 
  getYouTubeMetadata, 
  uploadTranscriptionToSupabase, 
  createInitialVideoRecord,
  updateVideoStatus,
  saveVideoMetadataToSupabase,
  searchTranscriptions,
  getTranscriptionByJobId,
  processVideoThroughAIFunctions,
  VideoMetadata 
} from './supabase-utils';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Configure CORS pour permettre les requêtes depuis ChatGenius
app.use(cors({
  origin: [
    'https://chatgenius-app.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(express.json());

// Handle preflight requests explicitly
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

interface TranscriptionRequest {
  youtubeUrl: string;
  userId: string; // ID de l'utilisateur ChatGenius
  transcriptionModel?: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
  language?: string;
  temperature?: number;
}

interface TranscriptionResponse {
  success: boolean;
  jobId: string;
  downloadUrl?: string;
  transcript?: {
    text: string;
    segments?: any[];
    language?: string;
    duration?: number;
    usage?: any;
    chunksProcessed?: number;
  };
  supabaseUrl?: string;
  error?: string;
  chunksProcessed?: number;
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/**
 * Get audio duration using ffprobe
 */
async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const command = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`;
    const { stdout } = await execAsync(command);
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error('❌ Failed to get audio duration:', error);
    return 0;
  }
}

/**
 * Split audio file into chunks using ffmpeg
 */
async function splitAudioFile(
  inputPath: string,
  outputDir: string,
  chunkDurationSeconds: number = 1400
): Promise<string[]> {
  try {
    const jobId = path.basename(inputPath, '.mp3');
    const chunkPaths: string[] = [];
    
    // Get total duration
    const totalDuration = await getAudioDuration(inputPath);
    const numChunks = Math.ceil(totalDuration / chunkDurationSeconds);
    
    console.log(`📂 Splitting audio into ${numChunks} chunks of ${chunkDurationSeconds}s each`);
    
    // Create chunks in parallel
    const chunkPromises = [];
    for (let i = 0; i < numChunks; i++) {
      const startTime = i * chunkDurationSeconds;
      const chunkPath = path.join(outputDir, `${jobId}_chunk_${i}.mp3`);
      chunkPaths.push(chunkPath);
      
      const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${chunkDurationSeconds} -acodec libmp3lame "${chunkPath}" -y`;
      chunkPromises.push(execAsync(command));
    }
    
    // Wait for all chunks to be created
    await Promise.all(chunkPromises);
    console.log(`✅ Created ${numChunks} audio chunks`);
    
    return chunkPaths;
  } catch (error) {
    console.error('❌ Failed to split audio file:', error);
    throw error;
  }
}

/**
 * Transcribes multiple audio chunks in parallel and merges results
 */
async function transcribeAudioChunksParallel(
  chunkPaths: string[],
  options: {
    apiKey: string;
    model: string;
    language?: string;
    temperature?: number;
    prompt?: string;
  },
  chunkDurationSeconds: number = 1400
): Promise<any> {
  const openai = new OpenAI({ apiKey: options.apiKey });
  const isGPT4oModel = options.model.includes('gpt-4o');
  
  console.log(`🎙️ Starting parallel transcription of ${chunkPaths.length} chunks`);
  
  // Transcribe all chunks in parallel
  const transcriptionPromises = chunkPaths.map(async (chunkPath, index) => {
    console.log(`🔄 Transcribing chunk ${index + 1}/${chunkPaths.length}`);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkPath),
      model: options.model,
      response_format: isGPT4oModel ? 'json' : 'verbose_json',
      timestamp_granularities: isGPT4oModel ? undefined : ['segment'],
      language: options.language,
      temperature: options.temperature ?? 0,
      prompt: options.prompt
    });
    
    console.log(`✅ Completed chunk ${index + 1}/${chunkPaths.length}`);
    
    return {
      index,
      text: transcription.text,
      segments: (transcription as any).segments || [],
      language: (transcription as any).language,
      duration: (transcription as any).duration || chunkDurationSeconds,
      usage: (transcription as any).usage,
      timeOffset: index * chunkDurationSeconds
    };
  });
  
  // Wait for all transcriptions to complete
  const results = await Promise.all(transcriptionPromises);
  
  // Sort results by index to maintain order
  results.sort((a, b) => a.index - b.index);
  
  // Merge all results
  let mergedText = '';
  let mergedSegments: any[] = [];
  let totalDuration = 0;
  let totalUsage = {
    type: 'duration',
    seconds: 0
  };
  
  let segmentIdCounter = 0;
  
  results.forEach((result, chunkIndex) => {
    // Merge text with space separator
    if (mergedText) mergedText += ' ';
    mergedText += result.text.trim();
    
    // Adjust segment timestamps and IDs
    if (result.segments && result.segments.length > 0) {
      const adjustedSegments = result.segments.map((segment: any) => ({
        ...segment,
        id: segmentIdCounter++,
        start: segment.start + result.timeOffset,
        end: segment.end + result.timeOffset,
        seek: Math.floor((segment.start + result.timeOffset) * 100) // Convert to centiseconds
      }));
      
      mergedSegments.push(...adjustedSegments);
    }
    
    // Accumulate usage
    if (result.usage && result.usage.seconds) {
      totalUsage.seconds += result.usage.seconds;
    } else if (result.usage && result.usage.total_tokens) {
      // For token-based models, just add up the tokens
      totalUsage.seconds += result.usage.total_tokens;
    }
    
    totalDuration = Math.max(totalDuration, result.timeOffset + (result.duration || 0));
  });
  
  // Clean up chunk files
  chunkPaths.forEach(chunkPath => {
    try {
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup chunk: ${chunkPath}`);
    }
  });
  
  console.log(`✅ Merged ${results.length} transcription chunks`);
  
  return {
    text: mergedText,
    segments: mergedSegments,
    language: results[0]?.language || 'unknown',
    duration: totalDuration,
    usage: totalUsage,
    chunksProcessed: results.length
  };
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'YouTube Transcription Service',
    timestamp: new Date().toISOString()
  });
});

/**
 * Download YouTube video and transcribe
 */
app.post('/transcribe', async (req, res) => {
  const { youtubeUrl, userId, transcriptionModel = 'whisper-1', language, temperature }: TranscriptionRequest = req.body;
  
  if (!youtubeUrl) {
    return res.status(400).json({
      success: false,
      error: 'youtubeUrl is required'
    });
  }

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: 'userId is required'
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'OPENAI_API_KEY not configured'
    });
  }

  const jobId = uuidv4();
  console.log(`🎵 Starting job ${jobId} for URL: ${youtubeUrl}`);

  // 🔄 Créer l'enregistrement initial avec statut "Upload"
  const recordId = await createInitialVideoRecord(jobId, youtubeUrl, userId);
  if (!recordId) {
    console.warn('⚠️ Failed to create initial record, continuing without database tracking');
  }

  // Récupérer les métadonnées YouTube d'abord
  console.log(`📋 Getting YouTube metadata for job ${jobId}`);
  const youtubeMetadata = await getYouTubeMetadata(youtubeUrl);

  try {
    // 🔄 Mettre à jour le statut à "Ingestion"
    await updateVideoStatus(jobId, 'Ingestion');
    // Download video using yt-dlp
    const filename = `${jobId}.mp3`;
    const outputPath = path.join(uploadsDir, filename);
    
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" --extract-audio --audio-format mp3 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --referer "https://www.youtube.com/" "${youtubeUrl}" -o "${outputPath.replace('.mp3', '.%(ext)s')}"`;
    
    console.log(`📥 Downloading: ${command}`);
    const { stdout, stderr } = await execAsync(command, { timeout: 300000 }); // 5 minute timeout
    
    console.log(`✅ Download completed for job ${jobId}`);
    
    // Check if file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('MP3 file was not created');
    }

    // Check audio duration and transcribe (with automatic chunking if needed)
    console.log(`🎙️ Starting transcription for job ${jobId}`);
    const duration = await getAudioDuration(outputPath);
    console.log(`🎵 Audio duration: ${duration.toFixed(2)} seconds`);
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const isGPT4oModel = transcriptionModel.includes('gpt-4o');
    
    // For GPT-4o models, check if we need to split (1400s limit)
    // For whisper-1, we can handle longer files but chunking can still be beneficial for very long files
    const maxDuration = isGPT4oModel ? 1400 : 3600; // 1400s for GPT-4o, 1 hour for Whisper
    
    console.log(`🔍 Model: ${transcriptionModel}, isGPT4o: ${isGPT4oModel}, maxDuration: ${maxDuration}, actualDuration: ${duration}`);
    
    let transcriptData;
    
    if (duration >= maxDuration) {
      console.log(`⚠️ Audio duration (${duration}s) exceeds limit (${maxDuration}s). Using chunked transcription.`);
      
      // Create temporary directory for chunks
      const tempDir = path.join(path.dirname(outputPath), 'chunks');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      try {
        // Split audio into chunks
        const chunkPaths = await splitAudioFile(outputPath, tempDir, maxDuration);
        
        // Transcribe all chunks in parallel
        transcriptData = await transcribeAudioChunksParallel(
          chunkPaths, 
          {
            apiKey: process.env.OPENAI_API_KEY!,
            model: transcriptionModel,
            language: language,
            temperature: temperature ?? 0
          },
          maxDuration
        );
        
        // Clean up temp directory
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('⚠️ Failed to cleanup temp directory:', cleanupError);
        }
        
        console.log(`✅ Chunked transcription completed for job ${jobId} (${transcriptData.chunksProcessed} chunks)`);
      } catch (error) {
        // Clean up on error
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('⚠️ Failed to cleanup temp directory after error:', cleanupError);
        }
        throw error;
      }
    } else {
      // File is small enough, use standard transcription
      console.log(`✅ Audio duration within limits, using standard transcription`);
      
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(outputPath),
        model: transcriptionModel,
        response_format: isGPT4oModel ? 'json' : 'verbose_json',
        timestamp_granularities: isGPT4oModel ? undefined : ['segment'],
        language: language,
        temperature: temperature ?? 0,
      });

      transcriptData = {
        text: transcription.text,
        segments: (transcription as any).segments,
        language: (transcription as any).language,
        duration: (transcription as any).duration,
        usage: (transcription as any).usage,
        chunksProcessed: 1
      };
      
      console.log(`✅ Standard transcription completed for job ${jobId}`);
    }

    // Upload vers Supabase si configuré
    const supabaseUrl = await uploadTranscriptionToSupabase(
      jobId, 
      transcriptData, 
      transcriptData.text
    );

    // Sauvegarder les métadonnées dans la table Supabase
    if (youtubeMetadata && supabaseUrl) {
      const videoMetadata: VideoMetadata = {
        jobId,
        youtubeUrl,
        userId, // Ajouter l'ID utilisateur
        videoId: youtubeMetadata.videoId,
        title: youtubeMetadata.title,
        description: youtubeMetadata.description,
        views: youtubeMetadata.views,
        likes: youtubeMetadata.likes,
        channelName: youtubeMetadata.channelName,
        channelUrl: youtubeMetadata.channelUrl,
        durationSeconds: youtubeMetadata.durationSeconds,
        uploadDate: youtubeMetadata.uploadDate,
        transcriptionFilePath: supabaseUrl,
        transcriptionText: transcriptData.text,
        language: transcriptData.language,
        segmentsCount: transcriptData.segments?.length,
        transcriptionModel,
        openaiTokensUsed: transcriptData.usage?.total_tokens,
        fileSizeBytes: fs.statSync(outputPath).size
      };

      const metadataSaved = await saveVideoMetadataToSupabase(videoMetadata);
      
      // If metadata saved successfully, start AI processing pipeline
      if (metadataSaved && supabaseUrl) {
        console.log(`📶 Starting AI processing pipeline for job: ${jobId}`);
        
        // Run AI processing in background (don't await to avoid timeout)
        // Get the video_transcription_id by looking up the saved record
        setTimeout(async () => {
          try {
            const { getTranscriptionByJobId } = await import('./supabase-utils');
            const { data: transcriptionRecord } = await getTranscriptionByJobId(jobId);
            
            if (transcriptionRecord?.id) {
              await processVideoThroughAIFunctions(transcriptionRecord.id, jobId);
            } else {
              console.error(`❌ Could not find video transcription record for job: ${jobId}`);
            }
          } catch (aiError) {
            console.error(`❌ AI processing pipeline failed for job ${jobId}:`, aiError);
          }
        }, 1000); // Start after 1 second to ensure response is sent first
      }
    }

    const result: TranscriptionResponse = {
      success: true,
      jobId,
      downloadUrl: `/download/${filename}`,
      transcript: transcriptData,
      supabaseUrl: supabaseUrl || undefined,
      chunksProcessed: transcriptData.chunksProcessed || 1
    };

    // Cleanup file after 1 hour (optional)
    setTimeout(() => {
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
          console.log(`🧹 Cleaned up file for job ${jobId}`);
        }
      } catch (err) {
        console.error(`❌ Failed to cleanup ${outputPath}:`, err);
      }
    }, 60 * 60 * 1000);

    res.json(result);

  } catch (error) {
    console.error(`❌ Error for job ${jobId}:`, error);
    
    // Cleanup on error
    const outputPath = path.join(uploadsDir, `${jobId}.mp3`);
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }

    res.status(500).json({
      success: false,
      jobId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Download MP3 file
 */
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadsDir, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

/**
 * Recherche de transcriptions
 */
app.get('/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  
  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const { data, error } = await searchTranscriptions(q, Number(limit));
    
    if (error) {
      return res.status(500).json({ error: error });
    }

    res.json({
      query: q,
      results: data?.length || 0,
      transcriptions: data || []
    });
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Search failed' 
    });
  }
});

/**
 * Obtenir une transcription par job_id
 */
app.get('/transcription/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  try {
    const { data, error } = await getTranscriptionByJobId(jobId);
    
    if (error) {
      return res.status(500).json({ error });
    }
    
    if (!data) {
      return res.status(404).json({ error: 'Transcription not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to get transcription' 
    });
  }
});

/**
 * Get service info
 */
app.get('/info', async (req, res) => {
  try {
    // Check if yt-dlp is available
    const { stdout: ytdlpVersion } = await execAsync('yt-dlp --version');
    
    res.json({
      service: 'YouTube Transcription Service',
      version: '1.0.0',
      ytdlp: ytdlpVersion.trim(),
      openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
      supabase: process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY ? 'configured' : 'missing',
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({
      service: 'YouTube Transcription Service',
      version: '1.0.0',
      error: 'yt-dlp not available',
      openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
      supabase: process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY ? 'configured' : 'missing'
    });
  }
});

/**
 * List available transcription models
 */
app.get('/models', (req, res) => {
  res.json({
    models: [
      {
        id: 'whisper-1',
        name: 'Whisper v2',
        description: 'OpenAI Whisper model, good quality, lowest cost',
        supports_timestamps: true
      },
      {
        id: 'gpt-4o-mini-transcribe',
        name: 'GPT-4o Mini Transcribe',
        description: 'Fast and cost-effective, high quality',
        supports_timestamps: false
      },
      {
        id: 'gpt-4o-transcribe',
        name: 'GPT-4o Transcribe',
        description: 'Highest quality, higher cost',
        supports_timestamps: false
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`🚂 Railway YouTube Transcription Service running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Service info: http://localhost:${PORT}/info`);
  console.log(`🎵 Transcription endpoint: POST http://localhost:${PORT}/transcribe`);
});

export default app;
