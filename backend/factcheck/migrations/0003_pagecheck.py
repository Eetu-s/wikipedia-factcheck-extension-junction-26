import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("factcheck", "0002_explanation_analysis")]

    operations = [
        migrations.CreateModel(
            name="PageCheck",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("sentence_id", models.CharField(max_length=200)),
                ("original_text", models.TextField()),
                ("context", models.JSONField(default=dict)),
                ("decision", models.CharField(max_length=30)),
                ("confidence", models.FloatField()),
                ("sources", models.JSONField(default=list)),
                ("evidence", models.JSONField(default=list)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("explanation", models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to="factcheck.explanation")),
            ],
        ),
    ]
