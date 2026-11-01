FROM python:3.11-slim

# FFmpeg for audio decoding + resampling
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# Render free tier has slow disk - pre-downloading model times out, so we skip it here and lazy-download on first request
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
RUN mkdir -p jobs

EXPOSE 8000
# Use $PORT from host (Render/Railway/Fly inject it)
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
