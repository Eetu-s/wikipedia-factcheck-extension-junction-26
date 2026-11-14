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
USER app

EXPOSE 8000

CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py runserver 0.0.0.0:8000"]
