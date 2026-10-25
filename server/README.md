# Wishes Audio Editor — Optional Vocal-Separation Server

The browser build includes an approximate, signal-processing vocal isolation that runs locally and is honest about its limitations. For studio-quality separation, you can run this optional backend that uses **Demucs** (Meta, MIT license) and exposes a `POST /separate` endpoint consumed by the Settings → Demucs server URL.

## Why a server

Demucs is a multi-megabyte PyTorch model. Running it in the browser via WASM/ONNX is currently slow and memory-heavy on phones. The browser build therefore uses a lightweight STFT mask; this server is the high-quality path.

## Requirements

- Python 3.10+ (3.11 recommended)
- FFmpeg installed and on `PATH` (for resampling/encoding if needed)
- At least 4 GB RAM for the small Demucs model; 8 GB for the full model

Verify: `python3 --version` and `ffmpeg -version`.

## Setup

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Pre-download the Demucs model (optional, cached on first request)
python -c "import demucs.api; demucs.api.Separator()"
```

## Run

```bash
# Environment
export PORT=8000
export DEMUCS_MODEL=htdemucs  # or htdemucs_ft, mdx_extra, etc.
export MAX_UPLOAD_MB=250
export CLEANUP_MINUTES=30
export CORS_ORIGINS="https://your-pages-site.example.com,http://localhost:5173"

uvicorn app:app --host 0.0.0.0 --port 8000
```

Health check: `GET /health` → `{"status":"ok","model":"htdemucs"}`.

## API

### POST /separate

- **Request**: `multipart/form-data` with field `file` (audio/*, max `MAX_UPLOAD_MB`).
- **Response**: JSON with temporary stem URLs:

```json
{
  "vocalUrl": "/files/<jobId>/vocals.wav",
  "instrumentalUrl": "/files/<jobId>/accompaniment.wav",
  "quality": 0.92,
  "message": "Demucs separation ready"
}
```

Files under `/files` are served with `Cache-Control: no-store` and deleted after `CLEANUP_MINUTES`. Do not rely on them for permanent storage.

### POST /separate (alternative)

If your client cannot fetch temporary URLs (e.g., CORS-restricted), the server also supports `?inline=1` to return base64-encoded WAV data in the JSON.

## Security

- Request size limit enforced before reading the full file.
- Randomized job IDs (UUIDv4); no predictable paths.
- Jobs isolated in `jobs/<jobId>/`.
- Timeouts: 5 minutes per job; process killed on timeout.
- Temporary files cleaned by background task.
- CORS restricted to `CORS_ORIGINS`. Never use `*` in production without authentication.
- No credentials are read from the repository. Set `DEMUCS_MODEL` and other env via your host's secrets UI.

## Deployment options

- **Recommended**: Fly.io, Render, Railway, or a VPS with Docker (see `Dockerfile` if added). GitHub Pages cannot run Python.
- The frontend is static (Vite) and can stay on GitHub Pages; set the server URL in the app's Settings.

## FFmpeg note

Installing FFmpeg alone does **not** provide vocal separation. Demucs (or another trained source-separation model) is required for high-quality results.

## License

Demucs is MIT-licensed but check its model weights license before commercial use. This server code follows the repository's license.
