"""Standalone database connection (PyMySQL).

The search functions only need a DB-API cursor that uses %s placeholders, so the Django
backend can pass its own `django.db.connection.cursor()` instead of using this module.
"""
import pymysql

from . import config


def connect(**overrides):
    params = {**config.DB, **overrides}
    return pymysql.connect(charset="utf8mb4", autocommit=False, **params)
