# Calorie Counter

Estimate the calories in a flask, bowl or plate of food from its volume, with an honest error range.

    fill level -> volume (ml) -> mass (g, via density) -> kcal (via kcal/100 g) -> range

## Run it

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn app.main:app --reload

Open http://127.0.0.1:8000. The same server hosts the page and the API.

On first start the database (`data/calorie.db`, override with `CALORIE_DB`) is seeded with ten
rough starting meals. Replace the numbers with your own and press **Save values**. To add a meal,
choose **Custom**, type a name and the numbers, and press **Save as new meal**.

## Tests

    .venv/bin/python -m pytest

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/foods?q=` | list or search meals |
| POST | `/api/foods` | add a meal `{name, kcal_per_100g, density_g_per_ml}` |
| PUT | `/api/foods/{id}` | update values (and optionally the name) |
| DELETE | `/api/foods/{id}` | delete a meal |
| GET / POST | `/api/containers` | list or add custom containers |
| DELETE | `/api/containers/{id}` | delete a custom container |

Interactive docs are at `/docs`.

## Offline behaviour

If the server is unreachable the page shows "Offline mode", uses the built-in table of meals, and
estimates still work. Meal changes are not saved while offline. Custom containers created offline
are kept in the browser and uploaded the next time the server is reachable.

