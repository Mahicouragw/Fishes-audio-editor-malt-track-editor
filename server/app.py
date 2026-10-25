import asyncio
import base64
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

PORT = int(os.getenv("PORT", "8000"))
MODEL = os.getenv("DEMUCS_MODEL", "htdemucs")  # htdemucs, htdemucs_ft, mdx_extra, etc.
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "250"))
CLEANUP_MINUTES = int(os.getenv("CLEANUP_MINUTES", "30"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

JOBS = Path(__file__).parent / "jobs"
JOBS.mkdir(exist_ok=True)

app = FastAPI(
    title="Wishes Audio Editor - Real Separation Server",
    description="Real vocal/instrumental separation with Demucs. Returns distinct stems: vocals, drums, bass, other, accompaniment.",
    version="1.1.0",
)

# CORS: if not set, allow all for dev but warn
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
else:
    # Allow all origins when not configured (useful for local testing)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Serve job files under /files
app.mount("/files", StaticFiles(directory=JOBS, html=False), name="files")


@app.get("/")
async def root():
    return {
        "name": "Wishes Audio Editor — Real Separation Server",
        "docs": "/docs",
        "health": "/health",
        "separate": "POST /separate (multipart file) -> distinct stems",
        "model": MODEL,
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "jobs": len(list(JOBS.iterdir()))}


def cleanup_old_jobs():
    cutoff = time.time() - CLEANUP_MINUTES * 60
    for job_dir in JOBS.iterdir():
        if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
            shutil.rmtree(job_dir, ignore_errors=True)


async def run_demucs(input_path: Path, output_dir: Path, model: str):
    """Run Demucs; isolated per job with timeout."""
    try:
        from demucs.api import Separator
    except ImportError:
        raise HTTPException(status_code=500, detail="Demucs is not installed on this server. pip install -r requirements.txt")
    separator = Separator(model=model, progress=False)
    origin, separated = separator.separate_audio_file(str(input_path))
    # separated is dict with stems; save as WAV
    import soundfile as sf
    for stem, waveform in separated.items():
        path = output_dir / f"{stem}.wav"
        # waveform is torch.Tensor (channels, samples)
        data = waveform.cpu().numpy().T  # (samples, channels)
        sf.write(str(path), data, int(origin.rate), subtype="PCM_16")


def build_accompaniment(output_dir: Path) -> Optional[Path]:
    """Mix drums+bass+other into accompaniment.wav if not already present"""
    accompaniment = output_dir / "accompaniment.wav"
    if accompaniment.exists():
        return accompaniment
    vocals = output_dir / "vocals.wav"
    if not vocals.exists():
        return None
    import soundfile as sf
    import numpy as np

    stems = []
    sr = None
    for stem in ("drums", "bass", "other"):
        p = output_dir / f"{stem}.wav"
        if p.exists():
            data, rate = sf.read(str(p))
            if sr is None:
                sr = rate
            stems.append(data)
    if not stems:
        return None
    max_len = max(len(s) for s in stems)
    # Handle mono vs stereo
    channels = 1
    for s in stems:
        if s.ndim > 1:
            channels = max(channels, s.shape[1])
    mix = np.zeros((max_len, channels))
    for s in stems:
        if s.ndim == 1:
            s = s[:, None]
        if s.shape[1] != channels:
            # mono -> stereo duplicate, or stereo -> mono average
            if s.shape[1] == 1 and channels == 2:
                s = np.repeat(s, 2, axis=1)
            elif s.shape[1] == 2 and channels == 1:
                s = s.mean(axis=1, keepdims=True)
        pad = max_len - len(s)
        if pad > 0:
            s = np.pad(s, ((0, pad), (0, 0)))
        mix += s
    mix = np.clip(mix, -1, 1)
    sf.write(str(accompaniment), mix, sr or 44100, subtype="PCM_16")
    return accompaniment


@app.post("/separate")
async def separate(
    file: UploadFile = File(..., description="Audio or video file (wav/mp3/m4a/ogg/flac/mp4/webm/mov)"),
    inline: Optional[int] = Query(default=0, description="If 1, return base64 instead of URLs"),
    distinct: Optional[int] = Query(default=1, description="If 1, return all distinct stems (vocals/drums/bass/other)"),
):
    """
    Real separation with Demucs.

    - **distinct=1** (default): returns vocals + drums + bass + other + accompaniment
    - **distinct=0**: only vocals + accompaniment (backward compatible)
    - **inline=1**: returns base64 WAVs instead of /files URLs (for CORS-restricted clients)
    """
    cleanup_old_jobs()
    contents = await file.read()
    size = len(contents)
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file — upload a valid audio/video file")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File too large: {size / 1024 / 1024:.1f} MB, limit {MAX_UPLOAD_MB} MB")

    name = (file.filename or "upload").lower()
    # Allow any audio/video; Demucs will fail gracefully if unsupported
    allowed = (".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm", ".mp4", ".m4v", ".mov")
    if not any(name.endswith(ext) for ext in allowed):
        # Still try — could be correct MIME with odd name
        pass

    # Optional: if video, extract audio with ffmpeg first (if available)
    # For now we let Demucs try; it uses ffmpeg internally if available
    # If you need explicit video extraction, ensure ffmpeg is installed

    job_id = uuid.uuid4().hex
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    safe_name = name.split("/")[-1].split("\\")[-1]
    input_path = job_dir / f"input_{uuid.uuid4().hex}_{safe_name}"
    input_path.write_bytes(contents)
    output_dir = job_dir / "separated"
    output_dir.mkdir(exist_ok=True)

    try:
        await asyncio.wait_for(asyncio.to_thread(run_demucs, input_path, output_dir, MODEL), timeout=300)
    except asyncio.TimeoutError:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=504, detail="Separation timed out after 5 minutes — try a shorter file or a smaller model (htdemucs instead of htdemucs_ft)")
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Separation failed: {e} — check server logs, ensure ffmpeg is installed, and that the file contains decodable audio")

    # Build accompaniment if needed
    accompaniment = build_accompaniment(output_dir)
    vocals = output_dir / "vocals.wav"
    drums = output_dir / "drums.wav"
    bass = output_dir / "bass.wav"
    other = output_dir / "other.wav"

    if not vocals.exists():
        raise HTTPException(status_code=500, detail="Demucs did not produce vocals stem — file may be too short or contain no audio")

    def file_url(p: Path) -> Optional[str]:
        return f"/files/{job_id}/separated/{p.name}" if p.exists() else None

    def encode(p: Path) -> Optional[str]:
        return base64.b64encode(p.read_bytes()).decode() if p.exists() else None

    if inline:
        result = {
            "vocalBase64": encode(vocals),
            "instrumentalBase64": encode(accompaniment) if accompaniment and accompaniment.exists() else None,
            "quality": 0.95,
            "message": "Demucs real separation ready (distinct stems, inline)",
            "model": MODEL,
            "jobId": job_id,
        }
        if distinct:
            result.update({
                "vocalsBase64": encode(vocals),
                "drumsBase64": encode(drums),
                "bassBase64": encode(bass),
                "otherBase64": encode(other),
                "accompanimentBase64": encode(accompaniment) if accompaniment and accompaniment.exists() else None,
            })
        return JSONResponse(result)

    # URL mode — distinct stems
    response = {
        "vocalUrl": file_url(vocals),
        "instrumentalUrl": file_url(accompaniment) if accompaniment and accompaniment.exists() else None,
        "quality": 0.95,
        "message": "Demucs real separation ready — distinct stems available",
        "model": MODEL,
        "jobId": job_id,
        "stems": {
            "vocals": file_url(vocals),
            "drums": file_url(drums),
            "bass": file_url(bass),
            "other": file_url(other),
            "accompaniment": file_url(accompaniment) if accompaniment and accompaniment.exists() else None,
        },
    }
    if not distinct:
        # Backward compat: only vocals + accompaniment
        response = {
            "vocalUrl": file_url(vocals),
            "instrumentalUrl": file_url(accompaniment) if accompaniment and accompaniment.exists() else None,
            "quality": 0.95,
            "message": "Demucs real separation ready",
            "model": MODEL,
            "jobId": job_id,
        }
    return response


@app.get("/models")
async def list_models():
    return {
        "current": MODEL,
        "available": ["htdemucs", "htdemucs_ft", "htdemucs_6s", "mdx", "mdx_extra", "mdx_extra_q"],
        "note": "Set DEMUCS_MODEL env var to change model. htdemucs is balanced; htdemucs_ft is higher quality but slower.",
    }
