"""Wikipedia RAG search on MariaDB Vector.

    from wikirag import semantic_search, format_results
    rows = semantic_search(cursor, "Which peace treaty ended the Winter War?")
    print(format_results(rows, query="..."))   # JSON string
    data = results_to_dict(rows, query="...")  # or the dict itself
"""
from .embedding import EmbeddingError, embed
from .formatting import format_results, results_to_dict
from .search import chunk_search, semantic_search

__all__ = ["semantic_search", "chunk_search", "format_results", "results_to_dict", "embed", "EmbeddingError"]
