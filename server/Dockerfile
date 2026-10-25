FROM python:3.11-slim

# FFmpeg for audio decoding + resampling
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
RUN mkdir -p jobs

# Pre-download the default model so first request is fast (optional, comment out if you want lazy download)
RUN python -c "from demucs.api import Separator; Separator(model='htdemucs', progress=True)" || echo "Model download will happen on first request"

EXPOSE 8000
# Use $PORT from host (Render/Railway/Fly inject it)
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
