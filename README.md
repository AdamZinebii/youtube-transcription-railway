# YouTube Transcription Service pour Railway

Service API standalone pour télécharger des vidéos YouTube et les transcrire avec OpenAI.

## 🚀 Déploiement sur Railway

### 1. Préparer le repo
```bash
cd railway-service
git init
git add .
git commit -m "Initial commit"
```

### 2. Variables d'environnement sur Railway
```
OPENAI_API_KEY=ton_api_key_openai
SUPABASE_URL=https://ton-projet.supabase.co
SUPABASE_ANON_KEY=ton_supabase_anon_key
```

### 3. Configuration Railway
- **Build Command**: `npm run build`
- **Start Command**: `npm start`
- **Port**: `3000` (automatique)

## 🗄️ Configuration Supabase

### 1. Créer le bucket de stockage
```sql
-- Créer le bucket pour les transcriptions
INSERT INTO storage.buckets (id, name, public) 
VALUES ('transcriptions', 'transcriptions', true);

-- Policy pour permettre l'upload et la lecture
CREATE POLICY "Allow public uploads" ON storage.objects 
FOR INSERT WITH CHECK (bucket_id = 'transcriptions');

CREATE POLICY "Allow public downloads" ON storage.objects 
FOR SELECT USING (bucket_id = 'transcriptions');
```

### 2. Créer la table des métadonnées
```sql
-- Créer la table des métadonnées
CREATE TABLE video_transcriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id VARCHAR(255) UNIQUE NOT NULL,
  youtube_url TEXT NOT NULL,
  video_id VARCHAR(50) NOT NULL,
  
  -- Métadonnées vidéo
  title TEXT NOT NULL,
  description TEXT,
  views BIGINT,
  likes BIGINT,
  channel_name TEXT,
  channel_url TEXT,
  duration_seconds INTEGER,
  upload_date DATE,
  
  -- Transcription
  transcription_file_path TEXT NOT NULL,
  transcription_text TEXT NOT NULL,
  language VARCHAR(10),
  segments_count INTEGER,
  
  -- Métadonnées système
  transcription_model VARCHAR(50) DEFAULT 'whisper-1',
  openai_tokens_used INTEGER,
  file_size_bytes BIGINT,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour les recherches
CREATE INDEX idx_video_transcriptions_video_id ON video_transcriptions(video_id);
CREATE INDEX idx_video_transcriptions_job_id ON video_transcriptions(job_id);
CREATE INDEX idx_video_transcriptions_created_at ON video_transcriptions(created_at);

-- RLS (Row Level Security)
ALTER TABLE video_transcriptions ENABLE ROW LEVEL SECURITY;

-- Policy pour permettre la lecture publique
CREATE POLICY "Allow public read" ON video_transcriptions
FOR SELECT USING (true);

-- Policy pour permettre l'insertion publique
CREATE POLICY "Allow public insert" ON video_transcriptions
FOR INSERT WITH CHECK (true);
```

## 📡 API Endpoints

### `GET /health`
Vérification de l'état du service
```json
{
  "status": "ok",
  "service": "YouTube Transcription Service",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### `GET /info`
Informations sur le service et les dépendances
```json
{
  "service": "YouTube Transcription Service",
  "version": "1.0.0",
  "ytdlp": "2024.01.01",
  "openai": "configured",
  "uptime": 3600,
  "memory": {...}
}
```

### `GET /models`
Liste des modèles de transcription disponibles
```json
{
  "models": [
    {
      "id": "whisper-1",
      "name": "Whisper v2",
      "description": "OpenAI Whisper model, good quality, lowest cost",
      "supports_timestamps": true
    }
  ]
}
```

### `POST /transcribe`
Télécharge et transcrit une vidéo YouTube

**Request:**
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "transcriptionModel": "whisper-1",
  "language": "en",
  "temperature": 0
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "uuid-here",
  "downloadUrl": "/download/uuid.mp3",
  "supabaseUrl": "https://storage.supabase.co/v1/object/public/transcriptions/uuid_transcript.json",
  "transcript": {
    "text": "Transcribed text here...",
    "segments": [...],
    "language": "english",
    "duration": 213.5,
    "usage": {...}
  }
}
```

### `GET /search?q=query&limit=10`
Recherche dans les transcriptions sauvegardées
```json
{
  "query": "never gonna give you up",
  "results": 1,
  "transcriptions": [
    {
      "id": "uuid",
      "job_id": "job-uuid",
      "title": "Rick Astley - Never Gonna Give You Up",
      "channel_name": "Rick Astley",
      "views": 1600000000,
      "transcription_file_path": "https://storage.supabase.co/...",
      "created_at": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### `GET /transcription/:jobId`
Récupérer une transcription spécifique par job ID
```json
{
  "id": "uuid",
  "job_id": "job-uuid",
  "youtube_url": "https://youtube.com/watch?v=...",
  "title": "Video Title",
  "transcription_text": "Full transcript...",
  "language": "english",
  "segments_count": 29,
  "created_at": "2024-01-01T12:00:00Z"
}
```

### `GET /download/:filename`
Télécharge le fichier MP3 généré

## 🛠 Test local

```bash
# Installer les dépendances
npm install

# Lancer en dev
npm run dev

# Test avec curl
curl -X POST http://localhost:3000/transcribe \
  -H "Content-Type: application/json" \
  -d '{"youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## 📋 Fonctionnalités

- ✅ Téléchargement YouTube avec `yt-dlp`
- ✅ Conversion automatique en MP3
- ✅ Transcription avec OpenAI (Whisper, GPT-4o)
- ✅ Support des timestamps (segments)
- ✅ **Stockage Supabase** - Transcriptions sauvées dans le cloud
- ✅ **Base de données** - Métadonnées vidéo indexées et searchables
- ✅ **Recherche full-text** - Recherche dans les transcriptions
- ✅ **API complète** - Endpoints pour search, retrieve, transcribe
- ✅ Nettoyage automatique des fichiers locaux (1h)
- ✅ Gestion d'erreurs robuste
- ✅ Compatible Railway/Docker

## ⚙️ Configuration

### Variables d'environnement obligatoires:
- `OPENAI_API_KEY` - Clé API OpenAI

### Variables optionnelles:
- `PORT` - Port du serveur (défaut: 3000)
- `SUPABASE_URL` - URL du projet Supabase (pour le stockage)
- `SUPABASE_ANON_KEY` - Clé anonyme Supabase (pour le stockage)

## 🔧 Architecture

```
railway-service/
├── server.ts          # Serveur Express principal
├── package.json       # Dépendances Node.js
├── Dockerfile         # Configuration Docker
├── tsconfig.json      # Configuration TypeScript
└── uploads/           # Fichiers temporaires (auto-nettoyage)
```
