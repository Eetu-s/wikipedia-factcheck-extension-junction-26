from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health, name="health"),
    path("factcheck/", views.factcheck, name="factcheck"),
    path("factcheck/batch/", views.factcheck_batch, name="factcheck-batch"),
    path("factcheck/check/<uuid:check_id>/", views.page_check, name="page-check"),
    path("factcheck/check/<uuid:check_id>/analyze/", views.analyze_page_check, name="analyze-page-check"),
    path("factcheck-ratelimit/", views.factcheck_ratelimit, name="factcheck-ratelimit"),
    path("factcheck/explanation/<uuid:explanation_id>/", views.explanation, name="explanation"),
]
