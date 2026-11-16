"""The app's data store: schema spi, in an existing database or its own (backend/db/scheme_performance_calculator/README.md): every
source file's data and the saved versions."""
from __future__ import annotations

import threading

import psycopg

from app.config import get_settings

_pool = None
_pool_lock = threading.Lock()


def connect(owner: bool = False, **kwargs) -> psycopg.Connection:
    """The app's login, or with owner=True the owner's (migrations and loads create tables and partitions)."""
    settings = get_settings()
    url = settings.spi_owner_url if owner else settings.spi_database_url
    if url is None:
        raise RuntimeError(f"{'SPI_OWNER_URL' if owner else 'SPI_DATABASE_URL'} is not set")
    return psycopg.connect(url.get_secret_value(), **kwargs)


def connection():
    """A connection from the API's pool, as `with connection() as conn:` (one transaction, back to the pool)."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg_pool import ConnectionPool

                url = get_settings().spi_database_url
                if url is None:
                    raise RuntimeError("SPI_DATABASE_URL is not set")
                _pool = ConnectionPool(url.get_secret_value(), min_size=1, max_size=10, timeout=30, open=True,
                                       check=ConnectionPool.check_connection, name="spi-api")
    return _pool.connection()


def close_pool() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def configured() -> bool:
    """The database is set up for this server (saving versions, loading files)."""
    return get_settings().spi_database_url is not None


def enabled() -> bool:
    """Month data is read from the database (DATA_SOURCE=spi)."""
    settings = get_settings()
    return settings.data_source == "spi" and settings.spi_database_url is not None
