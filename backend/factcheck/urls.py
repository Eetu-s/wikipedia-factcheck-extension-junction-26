from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health, name="health"),
    path("factcheck/", views.factcheck, name="factcheck"),
    path("factcheck-ratelimit/", views.factcheck_ratelimit, name="factcheck-ratelimit"),
    path("factcheck/explanation/<uuid:explanation_id>/", views.explanation, name="explanation"),
]
