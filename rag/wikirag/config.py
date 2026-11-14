"""Settings, read from the environment (or rag/.env).

Prefixed with RAG_ so they never collide with the Django backend's own settings.
The defaults match rag/docker-compose.yml.
"""
import os
from pathlib import Path

RAG_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = RAG_DIR.parent

_env = RAG_DIR / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())

DB = dict(
    host=os.environ.get("RAG_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("RAG_DB_PORT", "3307")),
    user=os.environ.get("RAG_DB_USER", "wikirag"),
    password=os.environ.get("RAG_DB_PASSWORD", "wikirag"),
    database=os.environ.get("RAG_DB_NAME", "wikirag"),
)

# Embedding model, run by Ollama. Questions MUST be embedded with the same model as the
# stored article vectors (bge-m3, 1024 dimensions).
OLLAMA_URL = os.environ.get("RAG_OLLAMA_URL", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "bge-m3")
EMBED_CONTEXT = 8192
# Ollama needs both: num_ctx alone is not enough, because an embedding must fit in one batch
# and the default batch is 2,048 tokens (longer input is refused or silently cut).
EMBED_OPTIONS = {"num_ctx": EMBED_CONTEXT, "num_batch": EMBED_CONTEXT}
EMBED_TIMEOUT = float(os.environ.get("RAG_EMBED_TIMEOUT", "60"))

# Candidates one vector-index search looks at. With M=16, 80 found 100% of the exact top 10
# in the demo's measurements (~5 ms). MariaDB's default of 20 found only ~79%.
EF_SEARCH = int(os.environ.get("RAG_EF_SEARCH", "80"))

# Where load.py keeps downloaded data files. data/ is git-ignored.
DATA_DIR = Path(os.environ.get("RAG_DATA_DIR", REPO_DIR / "data" / "wikirag"))
