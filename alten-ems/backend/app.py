from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Alten EMS Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"status": "Alten EMS Backend running"}


@app.get("/api/prices")
def get_prices():
    return [
        9000, 7600, 6877, 6800, 7000, 7222,
        7766.99, 8000, 6700, 5550, 1650, 30,
        10, 10, 10, 44, 643, 1700,
        5957, 9939, 13700, 15000, 15000, 11000
    ]


@app.get("/api/batteries")
def get_batteries():
    return [
        {
            "id": "batt_1",
            "name": "ALTEN Battery 1",
            "capacity_kwh": 215,
            "max_charge_kw": 125,
            "max_discharge_kw": 125,
            "min_soc_percent": 10,
            "efficiency_percent": 92
        }
    ]


@app.post("/api/plan/apply")
def apply_plan(plan: dict):
    return {
        "ok": True,
        "message": "Plan received",
        "plan": plan
    }
