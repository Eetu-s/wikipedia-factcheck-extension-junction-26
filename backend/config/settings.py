import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-change-me")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = [host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if host.strip()]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = os.environ.get("DJANGO_SECURE_SSL_REDIRECT", "1") == "1"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = SECURE_HSTS_SECONDS > 0

# Log level for this project's own code (e.g. "DEBUG" shows RAG search distances).
LOG_LEVEL = os.environ.get("LOG_LEVEL", "DEBUG" if DEBUG else "INFO")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"factcheck": {"handlers": ["console"], "level": LOG_LEVEL}},
}

# Hash (from django.contrib.auth.hashers.make_password) of the password required by /api/factcheck/.
# Empty means the endpoint rejects every request.
FACTCHECK_PASSWORD_HASH = os.environ.get("FACTCHECK_PASSWORD_HASH", "")

# Google Gemini API key, used by factcheck/checker.py to make the fact-check decision.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
# Cheap Gemini text model that writes the explanation (factcheck/explainer.py).
GEMINI_EXPLAIN_MODEL = os.environ.get("GEMINI_EXPLAIN_MODEL", "gemini-3.5-flash")

# Shared page-scan pools, per server process. Keep concurrent scans from multiplying
# their own worker pools, while overlapping Wikipedia retrieval and model requests.
PAGE_SCAN_RETRIEVAL_WORKERS = max(1, min(16, int(os.environ.get("PAGE_SCAN_RETRIEVAL_WORKERS", "4"))))
PAGE_SCAN_DECISION_WORKERS = max(1, min(128, int(os.environ.get("PAGE_SCAN_DECISION_WORKERS", "32"))))

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "factcheck",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
 "NAME": os.environ.get("DJANGO_DB_PATH", str(BASE_DIR / "db.sqlite3")),
    }
}

# Durable benchmark snapshot, separate from short-lived explanation rows. Page reads never run it.
ACCURACY_RESULTS_PATH = os.environ.get(
    "ACCURACY_RESULTS_PATH", str(Path(DATABASES["default"]["NAME"]).parent / "accuracy-results.json")
)

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
