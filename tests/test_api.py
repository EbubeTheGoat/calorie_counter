import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    with TestClient(app) as c:  # runs lifespan, so the DB is created and seeded
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_seeded_foods(client):
    foods = client.get("/api/foods").json()
    assert len(foods) == 10
    jollof = next(f for f in foods if f["id"] == "jollof-rice")
    assert jollof["kcal_per_100g"] == 165 and jollof["source"] == "seed"


def test_seed_is_not_repeated_after_delete(client):
    assert client.delete("/api/foods/jollof-rice").status_code == 204
    with TestClient(app) as again:  # simulates a restart; table is non-empty, so no reseed
        ids = [f["id"] for f in again.get("/api/foods").json()]
    assert "jollof-rice" not in ids


def test_search(client):
    names = [f["name"] for f in client.get("/api/foods", params={"q": "rice"}).json()]
    assert sorted(names) == ["Cooked white rice", "Jollof rice"]


def test_create_update_delete_food(client):
    r = client.post("/api/foods", json={"name": "Moi moi", "kcal_per_100g": 150, "density_g_per_ml": 0.95})
    assert r.status_code == 201
    assert r.json() == {"id": "moi-moi", "name": "Moi moi", "kcal_per_100g": 150, "density_g_per_ml": 0.95, "source": "user"}

    assert client.post("/api/foods", json={"name": "Moi moi", "kcal_per_100g": 1, "density_g_per_ml": 1}).status_code == 409

    r = client.put("/api/foods/jollof-rice", json={"kcal_per_100g": 190, "density_g_per_ml": 0.8})
    assert r.status_code == 200
    assert r.json()["kcal_per_100g"] == 190 and r.json()["source"] == "user"
    assert r.json()["name"] == "Jollof rice"  # name untouched when omitted

    assert client.delete("/api/foods/moi-moi").status_code == 204
    assert client.delete("/api/foods/moi-moi").status_code == 404
    assert client.put("/api/foods/nope", json={"kcal_per_100g": 1, "density_g_per_ml": 1}).status_code == 404


@pytest.mark.parametrize("payload", [
    {"name": "", "kcal_per_100g": 100, "density_g_per_ml": 1},
    {"name": "x", "kcal_per_100g": 0, "density_g_per_ml": 1},
    {"name": "x", "kcal_per_100g": 901, "density_g_per_ml": 1},
    {"name": "x", "kcal_per_100g": 100, "density_g_per_ml": 0.05},
    {"name": "x", "kcal_per_100g": 100, "density_g_per_ml": 2.5},
])
def test_food_validation(client, payload):
    assert client.post("/api/foods", json=payload).status_code == 422


def test_containers_roundtrip(client):
    assert client.get("/api/containers").json() == []

    flask = client.post("/api/containers", json={"name": "Blue flask", "shape": "cylinder", "capacity_ml": 500}).json()
    bowl = client.post("/api/containers", json={
        "name": "Bowl", "shape": "tapered", "top_diam_cm": 14, "base_diam_cm": 8, "height_cm": 6}).json()
    plate = client.post("/api/containers", json={"name": "Plate", "shape": "plate", "diameter_cm": 27}).json()

    listed = client.get("/api/containers").json()
    assert [c["name"] for c in listed] == ["Blue flask", "Bowl", "Plate"]
    assert flask["capacity_ml"] == 500 and flask["top_diam_cm"] is None
    assert bowl["height_cm"] == 6 and bowl["capacity_ml"] is None
    assert plate["diameter_cm"] == 27

    assert client.delete(f"/api/containers/{flask['id']}").status_code == 204
    assert client.delete(f"/api/containers/{flask['id']}").status_code == 404
    assert len(client.get("/api/containers").json()) == 2


@pytest.mark.parametrize("payload", [
    {"name": "a", "shape": "cylinder"},
    {"name": "a", "shape": "cylinder", "capacity_ml": 10},
    {"name": "a", "shape": "tapered", "top_diam_cm": 10, "base_diam_cm": 5},
    {"name": "a", "shape": "plate", "diameter_cm": 2},
    {"name": "a", "shape": "cube", "capacity_ml": 500},
])
def test_container_validation(client, payload):
    assert client.post("/api/containers", json=payload).status_code == 422


def test_frontend_is_served_and_api_not_shadowed(client):
    page = client.get("/")
    assert page.status_code == 200 and "Calorie Counter" in page.text
    assert client.get("/api/foods").headers["content-type"].startswith("application/json")
