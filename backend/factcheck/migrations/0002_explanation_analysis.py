from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("factcheck", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="explanation",
            name="analysis",
            field=models.JSONField(default=dict),
        ),
    ]
