# Wishes Audio Editor — Real Separation Server (Python + Demucs, Distinct Stems)

**Real** vocal/instrumental separation (not an EQ). Uses **Demucs** (Meta, MIT) to return **distinct stems**: `vocals`, `drums`, `bass`, `other`, plus mixed `accompaniment` (drums+bass+other). The browser editor then lets you pitch/process the **vocal stem only**.

## Quick Start — 1-Click Deploy

### Render.com (free tier works, Docker easiest)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor)

1. Fork this repo, then in Render: **New → Web Service → connect your fork**
2. **Runtime:** Docker, **Dockerfile path:** `server/Dockerfile`
3. Set env: `DEMUCS_MODEL=htdemucs`, `CORS_ORIGINS=https://mahicouragw.github.io` (your Pages URL)
4. Deploy → copy the URL (e.g. `https://your-app.onrender.com`) → paste into app **Settings → Separation server URL**

### Railway / Fly.io / VPS

Any Docker host works:

```bash
cd server
docker build -t wishes-demucs .
docker run -p 8000:8000 -e CORS_ORIGINS=https://mahicouragw.github.io wishes-demucs
# Test:
curl http://localhost:8000/health
```

Or without Docker:

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # includes demucs, torch, fastapi, ffmpeg via apt
# On Debian/Ubuntu: sudo apt install ffmpeg
uvicorn app:app --host 0.0.0.0 --port 8000
```

## API — Real Distinct Stems

### POST /separate

**Request:** `multipart/form-data` with field `file` (audio or video: wav/mp3/m4a/aac/ogg/flac/webm/mp4/mov, max `MAX_UPLOAD_MB`)

**Response (distinct=1, default):**

```json
{
  "vocalUrl": "/files/<job>/separated/vocals.wav",
  "instrumentalUrl": "/files/<job>/separated/accompaniment.wav",
  "quality": 0.95,
  "message": "Demucs real separation ready — distinct stems available",
  "model": "htdemucs",
  "jobId": "abc123",
  "stems": {
    "vocals": "/files/<job>/separated/vocals.wav",
    "drums": "/files/<job>/separated/drums.wav",
    "bass": "/files/<job>/separated/bass.wav",
    "other": "/files/<job>/separated/other.wav",
    "accompaniment": "/files/<job>/separated/accompaniment.wav"
  }
}
```

Query params:
- `?distinct=0` → only vocals + accompaniment (backward compat)
- `?inline=1` → returns base64 WAVs in JSON (`vocalBase64`, `drumsBase64`, …) for CORS-restricted clients

All `/files/...` URLs are temporary, `no-store`, auto-deleted after `CLEANUP_MINUTES`.

### Other endpoints

- `GET /health` → `{"status":"ok","model":"htdemucs"}`
- `GET /models` → available Demucs models
- `GET /docs` → Swagger UI

## Frontend Wiring (Wishes Audio Editor)

1. Open your deployed site or `npm run dev`
2. **Settings → Vocal separation → Demucs server URL** → paste `https://your-server.com` (no trailing slash)
3. In **Studio**, select a track → **Human Voice Processing → Run vocal separation** → now you have distinct `vocals`/`drums`/`bass`/`other` as separate URLs you can import to new tracks
4. The editor's **Harmony** and **Pitch** can then target the isolated vocal stem only

> Tip: If your host requires it, set `CORS_ORIGINS` to include `https://mahicouragw.github.io` and `http://localhost:5173`

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | 8000 | Render/Railway inject this |
| `DEMUCS_MODEL` | htdemucs | `htdemucs`, `htdemucs_ft` (higher quality, slower), `mdx_extra` |
| `MAX_UPLOAD_MB` | 250 | Reject larger |
| `CLEANUP_MINUTES` | 30 | Delete jobs after |
| `CORS_ORIGINS` | (allow all if unset) | Comma list, e.g. `https://mahicouragw.github.io,http://localhost:5173` |

## Requirements

- Python 3.10+ (3.11 recommended), 4 GB RAM (8 GB for `htdemucs_ft`)
- FFmpeg on `PATH` (`ffmpeg -version`) — Demucs uses it for decoding
- First request downloads the model (~80–300 MB cached)

## Why not just FFmpeg?

FFmpeg alone **cannot** do vocal separation. You need a trained source-separation model like Demucs.

## Local Test

```bash
curl -X POST http://localhost:8000/separate -F file=@song.mp3 | jq
# Should return vocals/drums/bass/other/accompaniment URLs
```

## License

Demucs is MIT but check model weights license for commercial use. This server follows the repo license.
