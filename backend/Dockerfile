FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Match the host user so files created in bind mounts (e.g. migrations) aren't root-owned.
ARG UID=1000
ARG GID=1000
RUN groupadd --gid "$GID" app && useradd --uid "$UID" --gid "$GID" --create-home app

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=app:app . .
# The RAG search package, from the "rag" build context (see docker-compose.yml).
COPY --from=rag --chown=app:app wikirag /rag/wikirag
ENV PYTHONPATH=/rag
RUN mkdir -p /data && chown app:app /data
USER app

EXPOSE 8000

# --threads: GET /api/factcheck/explanation/<id>/ waits up to 25 s for the explanation, so each
# worker must serve other requests meanwhile.

CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 2 --threads 8 --timeout 120"]
