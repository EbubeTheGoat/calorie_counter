"""SQLite storage for foods and custom containers.

A new connection is opened per call. That is fine for a single-user SQLite app and
avoids sharing connections across FastAPI's worker threads.
"""
import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("CALORIE_DB", Path(__file__).resolve().parent.parent / "data" / "calorie.db"))

# Rough starting values, used only to seed an empty database.
# kcal/100 g varies with recipe and oil, so the user is expected to overwrite these.
SEED_FOODS = [
    ("Cooked white rice", 130, 0.80),
    ("Jollof rice", 165, 0.80),
    ("Cooked beans", 130, 0.90),
    ("Cooked pasta", 155, 0.65),
    ("Pounded yam / swallow", 120, 1.00),
    ("Boiled yam (cubed)", 118, 0.85),
    ("Tomato stew", 120, 1.00),
    ("Vegetable / okra soup", 95, 1.00),
    ("Pepper soup (broth)", 45, 1.00),
    ("Pap / ogi", 60, 1.02),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kcal_per_100g REAL NOT NULL,
    density_g_per_ml REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',       -- 'seed' or 'user'
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    shape TEXT NOT NULL,
    capacity_ml REAL,
    top_diam_cm REAL,
    base_diam_cm REAL,
    height_cm REAL,
    diameter_cm REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "food"


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create tables and seed foods once, only when the foods table is empty."""
    with connect() as conn:
        conn.executescript(SCHEMA)
        (count,) = conn.execute("SELECT COUNT(*) FROM foods").fetchone()
        if count == 0:
            conn.executemany(
                "INSERT INTO foods (id, name, kcal_per_100g, density_g_per_ml, source) VALUES (?, ?, ?, ?, 'seed')",
                [(slugify(n), n, k, d) for n, k, d in SEED_FOODS],
            )
