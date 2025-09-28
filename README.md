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
```

### 3. Configuration Railway
- **Build Command**: `npm run build`
- **Start Command**: `npm start`
- **Port**: `3000` (automatique)

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
  "transcript": {
    "text": "Transcribed text here...",
    "segments": [...],
    "language": "english",
    "duration": 213.5,
    "usage": {...}
  }
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
- ✅ Nettoyage automatique des fichiers (1h)
- ✅ API RESTful complète
- ✅ Gestion d'erreurs robuste
- ✅ Compatible Railway/Docker

## ⚙️ Configuration

### Variables d'environnement obligatoires:
- `OPENAI_API_KEY` - Clé API OpenAI

### Variables optionnelles:
- `PORT` - Port du serveur (défaut: 3000)

## 🔧 Architecture

```
railway-service/
├── server.ts          # Serveur Express principal
├── package.json       # Dépendances Node.js
├── Dockerfile         # Configuration Docker
├── tsconfig.json      # Configuration TypeScript
└── uploads/           # Fichiers temporaires (auto-nettoyage)
```
