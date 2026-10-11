"""Calorie Counter API.

Serves the static frontend and a small JSON API for foods (kcal per 100 g and density)
and the user's custom containers.

This is a single-user app with no authentication. Do not expose it to the public
internet without adding auth in front of it.
"""
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles

from . import db
from .schemas import ContainerIn, ContainerOut, FoodIn, FoodOut, FoodUpdate

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Calorie Counter", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------- foods

def _food(row: sqlite3.Row) -> FoodOut:
    return FoodOut(
        id=row["id"], name=row["name"], kcal_per_100g=row["kcal_per_100g"],
        density_g_per_ml=row["density_g_per_ml"], source=row["source"],
    )


@app.get("/api/foods", response_model=list[FoodOut])
def list_foods(q: str = Query(default="", max_length=80)):
    like = f"%{q.strip().lower()}%"
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM foods WHERE lower(name) LIKE ? ORDER BY name COLLATE NOCASE", (like,)
        ).fetchall()
    return [_food(r) for r in rows]


@app.post("/api/foods", response_model=FoodOut, status_code=201)
def create_food(body: FoodIn):
    food_id = db.slugify(body.name)
    try:
        with db.connect() as conn:
            conn.execute(
                "INSERT INTO foods (id, name, kcal_per_100g, density_g_per_ml, source) VALUES (?, ?, ?, ?, 'user')",
                (food_id, body.name.strip(), body.kcal_per_100g, body.density_g_per_ml),
            )
            row = conn.execute("SELECT * FROM foods WHERE id = ?", (food_id,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A food with id '{food_id}' already exists")
    return _food(row)


@app.put("/api/foods/{food_id}", response_model=FoodOut)
def update_food(food_id: str, body: FoodUpdate):
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE foods SET name = COALESCE(?, name), kcal_per_100g = ?, density_g_per_ml = ?, "
            "source = 'user', updated_at = datetime('now') WHERE id = ?",
            (body.name.strip() if body.name else None, body.kcal_per_100g, body.density_g_per_ml, food_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Food not found")
        row = conn.execute("SELECT * FROM foods WHERE id = ?", (food_id,)).fetchone()
    return _food(row)


@app.delete("/api/foods/{food_id}", status_code=204)
def delete_food(food_id: str):
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM foods WHERE id = ?", (food_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Food not found")
    return Response(status_code=204)


# ----------------------------------------------------------- containers

def _container(row: sqlite3.Row) -> ContainerOut:
    return ContainerOut(
        id=row["id"], name=row["name"], shape=row["shape"], capacity_ml=row["capacity_ml"],
        top_diam_cm=row["top_diam_cm"], base_diam_cm=row["base_diam_cm"],
        height_cm=row["height_cm"], diameter_cm=row["diameter_cm"],
    )


@app.get("/api/containers", response_model=list[ContainerOut])
def list_containers():
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM containers ORDER BY created_at, rowid").fetchall()
    return [_container(r) for r in rows]


@app.post("/api/containers", response_model=ContainerOut, status_code=201)
def create_container(body: ContainerIn):
    cid = uuid.uuid4().hex[:12]
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO containers (id, name, shape, capacity_ml, top_diam_cm, base_diam_cm, height_cm, diameter_cm) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, body.name.strip(), body.shape, body.capacity_ml, body.top_diam_cm,
             body.base_diam_cm, body.height_cm, body.diameter_cm),
        )
        row = conn.execute("SELECT * FROM containers WHERE id = ?", (cid,)).fetchone()
    return _container(row)


@app.delete("/api/containers/{container_id}", status_code=204)
def delete_container(container_id: str):
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM containers WHERE id = ?", (container_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Container not found")
    return Response(status_code=204)


# Mounted last so it never shadows /api routes.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
