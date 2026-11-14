import uuid

from django.db import models


class Explanation(models.Model):
    """Evidence and analysis written in the background after the fast verdict is sent.

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
    # Refuted explanations: errors, unverified_facts, and incomplete. Empty for legacy rows.
    analysis = models.JSONField(default=dict)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
