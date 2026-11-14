from django.contrib import admin
from django.urls import include, path
from factcheck.views import accuracy, accuracy_css

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("factcheck.urls")),
    path("accuracy", accuracy, name="accuracy"),
    path("accuracy/", accuracy),
    path("accuracy.css", accuracy_css, name="accuracy_css"),
]
