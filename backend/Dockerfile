# Scheme Performance API (FastAPI). Built by docker-compose.yml at the repo root; see the comments there.
# Pinned by digest (5 Nov 2026), so a rebuild uses the same image; bump the tag and digest together.
FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
# Every version is pinned in requirements.txt (compiled from requirements.in), tzdata included.
RUN pip install -r requirements.txt

COPY app ./app
COPY db ./db

# Synced GCS files and their parquet caches (DATA_DIR). Mount a volume here so a restart does not re-download.
RUN useradd --create-home --uid 1000 app && mkdir -p /data/gcs && chown -R app:app /data
USER app
ENV DATA_DIR=/data/gcs

EXPOSE 8010
# One worker only: the caches are in memory and the daily loader runs inside this process.
# The tables are created or updated first when SPI_OWNER_URL is set (safe to re-run).
CMD ["sh", "-c", "if [ -n \"$SPI_OWNER_URL\" ]; then python -m app.spi.migrate; fi; exec uvicorn app.main:app --host 0.0.0.0 --port 8010"]
