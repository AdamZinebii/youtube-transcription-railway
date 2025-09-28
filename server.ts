import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

interface TranscriptionRequest {
  youtubeUrl: string;
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
  };
  error?: string;
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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
  const { youtubeUrl, transcriptionModel = 'whisper-1', language, temperature }: TranscriptionRequest = req.body;
  
  if (!youtubeUrl) {
    return res.status(400).json({
      success: false,
      error: 'youtubeUrl is required'
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

  try {
    // Download video using yt-dlp
    const filename = `${jobId}.mp3`;
    const outputPath = path.join(uploadsDir, filename);
    
    const command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 "${youtubeUrl}" -o "${outputPath.replace('.mp3', '.%(ext)s')}"`;
    
    console.log(`📥 Downloading: ${command}`);
    const { stdout, stderr } = await execAsync(command, { timeout: 300000 }); // 5 minute timeout
    
    console.log(`✅ Download completed for job ${jobId}`);
    
    // Check if file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('MP3 file was not created');
    }

    // Transcribe using OpenAI
    console.log(`🎙️ Starting transcription for job ${jobId}`);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const isGPT4oModel = transcriptionModel.includes('gpt-4o');
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: transcriptionModel,
      response_format: isGPT4oModel ? 'json' : 'verbose_json',
      timestamp_granularities: isGPT4oModel ? undefined : ['segment'],
      language: language,
      temperature: temperature ?? 0,
    });

    console.log(`✅ Transcription completed for job ${jobId}`);

    const result: TranscriptionResponse = {
      success: true,
      jobId,
      downloadUrl: `/download/${filename}`,
      transcript: {
        text: transcription.text,
        segments: (transcription as any).segments,
        language: (transcription as any).language,
        duration: (transcription as any).duration,
        usage: (transcription as any).usage
      }
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
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({
      service: 'YouTube Transcription Service',
      version: '1.0.0',
      error: 'yt-dlp not available',
      openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing'
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
