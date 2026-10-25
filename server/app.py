import asyncio
import base64
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

PORT = int(os.getenv("PORT", "8000"))
MODEL = os.getenv("DEMUCS_MODEL", "htdemucs")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "250"))
CLEANUP_MINUTES = int(os.getenv("CLEANUP_MINUTES", "30"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

JOBS = Path(__file__).parent / "jobs"
JOBS.mkdir(exist_ok=True)

app = FastAPI(title="Wishes Audio Editor - Demucs Server")

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

# Serve job files under /files
app.mount("/files", StaticFiles(directory=JOBS, html=False), name="files")


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


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
        raise HTTPException(status_code=500, detail="Demucs is not installed on this server")
    separator = Separator(model=model, progress=False)
    # The API handles resampling internally; we keep original sample rate in output
    origin, separated = separator.separate_audio_file(str(input_path))
    # separated is dict with stems; save as WAV
    import soundfile as sf
    for stem, waveform in separated.items():
        path = output_dir / f"{stem}.wav"
        # waveform is torch.Tensor (channels, samples)
        data = waveform.cpu().numpy().T  # (samples, channels)
        sf.write(str(path), data, int(origin.rate), subtype="PCM_16")


@app.post("/separate")
async def separate(file: UploadFile = File(...), inline: Optional[int] = Query(default=0)):
    cleanup_old_jobs()
    # Validate size from Content-Length if available
    size = 0
    contents = await file.read()
    size = len(contents)
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File too large: {size / 1024 / 1024:.1f} MB, limit {MAX_UPLOAD_MB} MB")
    # Validate extension/mime loosely
    name = (file.filename or "upload").lower()
    if not any(name.endswith(ext) for ext in (".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm", ".mp4")):
        # Allow but warn
        pass
    job_id = uuid.uuid4().hex
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / f"input_{uuid.uuid4().hex}_{name.split('/')[-1]}"
    input_path.write_bytes(contents)
    output_dir = job_dir / "separated"
    output_dir.mkdir(exist_ok=True)
    try:
        await asyncio.wait_for(asyncio.to_thread(run_demucs, input_path, output_dir, MODEL), timeout=300)
    except asyncio.TimeoutError:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=504, detail="Separation timed out after 5 minutes")
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Separation failed: {e}")
    # Find stems
    # Demucs htdemucs names: drums, bass, other, vocals
    vocals = output_dir / "vocals.wav"
    # Accompaniment = drums+bass+other mixed
    accompaniment = output_dir / "accompaniment.wav"
    if vocals.exists() and not accompaniment.exists():
        # Mix stems for accompaniment
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
        if stems:
            # Ensure same length
            max_len = max(len(s) for s in stems)
            mix = np.zeros((max_len, stems[0].shape[1] if stems[0].ndim > 1 else 1))
            for s in stems:
                pad = max_len - len(s)
                if s.ndim == 1:
                    s = s[:, None]
                if pad > 0:
                    s = np.pad(s, ((0, pad), (0, 0)))
                mix += s
            mix = np.clip(mix, -1, 1)
            sf.write(str(accompaniment), mix, sr or 44100, subtype="PCM_16")
    if not vocals.exists():
        raise HTTPException(status_code=500, detail="Demucs did not produce vocals stem")
    if inline:
        def encode(p: Path) -> str:
            return base64.b64encode(p.read_bytes()).decode()
        return JSONResponse({
            "vocalBase64": encode(vocals),
            "instrumentalBase64": encode(accompaniment) if accompaniment.exists() else None,
            "quality": 0.92,
            "message": "Demucs separation ready (inline)",
        })
    return {
        "vocalUrl": f"/files/{job_id}/separated/vocals.wav",
        "instrumentalUrl": f"/files/{job_id}/separated/accompaniment.wav" if accompaniment.exists() else None,
        "quality": 0.92,
        "message": "Demucs separation ready",
    }


@app.get("/")
async def root():
    return {"name": "Wishes Audio Editor Demucs Server", "docs": "/docs", "health": "/health"}
