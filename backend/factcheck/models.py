import uuid

from django.db import models


class Explanation(models.Model):
    """The paragraphs behind a verdict, written by a background LLM call after the verdict is sent.

    Kept in the database (not in memory) so every gunicorn worker process can serve it.
    """

    class Status(models.TextChoices):
        PENDING = "pending"
        DONE = "done"
        ERROR = "error"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    # [{"source": "<url>", "paragraph": "<text>"}, ...]
    paragraphs = models.JSONField(default=list)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
