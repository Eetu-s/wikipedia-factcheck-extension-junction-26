"""Turn text into vectors with bge-m3 through Ollama (port of the demo's common.embed())."""
import requests

from . import config


class EmbeddingError(RuntimeError):
    """Ollama could not be reached, or refused the input."""


_session = requests.Session()


def embed_many(texts, truncate=True, timeout=None):
    """Vectors for a list of texts. With truncate=False Ollama refuses over-long input."""
    try:
        r = _session.post(
            f"{config.OLLAMA_URL}/api/embed",
            timeout=config.EMBED_TIMEOUT if timeout is None else timeout,
            json={
                "model": config.EMBED_MODEL,
                "input": list(texts),
                "truncate": truncate,
                "options": config.EMBED_OPTIONS,
            },
        )
    except requests.RequestException as e:
        raise EmbeddingError(f"Ollama not reachable at {config.OLLAMA_URL}: {e}") from e
    if r.status_code != 200:
        raise EmbeddingError(f"Ollama returned {r.status_code}: {r.text[:300]}")
    return r.json()["embeddings"]


def embed(text, timeout=None):
    """One vector (a list of 1024 floats) for one question or statement."""
    [vector] = embed_many([text], timeout=timeout)
    return vector
