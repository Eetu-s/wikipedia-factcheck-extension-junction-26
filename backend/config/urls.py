from django.contrib import admin
from django.urls import include, path
from factcheck.views import accuracy

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("factcheck.urls")),
    path("accuracy", accuracy, name="accuracy"),
    path("accuracy/", accuracy),
]
