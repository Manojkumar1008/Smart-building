from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pymongo import MongoClient
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

app = FastAPI()

def get_app_timezone():
    try:
        return ZoneInfo("Europe/Dublin")
    except ZoneInfoNotFoundError:
        return datetime.now().astimezone().tzinfo


APP_TIMEZONE = get_app_timezone()


templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

client = MongoClient("mongodb://localhost:27017/")
db = client["smart_building"]
collection = db["sensor_data"]


@app.on_event("startup")
def ensure_indexes():
    # These indexes keep dashboard filter + sort queries responsive as history grows.
    collection.create_index([("timestamp", -1)])
    collection.create_index([("organization", 1), ("building", 1), ("timestamp", -1)])
    collection.create_index([("meter_events.floor", 1), ("timestamp", -1)])
    collection.create_index([("meter_events.machine", 1), ("timestamp", -1)])

@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return templates.TemplateResponse(request=request, name="dashboard.html", context={})

@app.post("/sensor-data")
def receive_data(data: dict):
    data["received_at"] = datetime.now(APP_TIMEZONE).isoformat()
    collection.insert_one(data)
    return {"status": "stored"}

@app.get("/data")
def get_data(
    organization: str | None = None,
    building: str | None = None,
    floor: str | None = None,
    machine: str | None = None,
    window: str = "hourly",
    limit: int = 300,
):
    query = {}
    if organization:
        query["organization"] = organization
    if building:
        query["building"] = building

    safe_limit = max(1, min(limit, 300000))
    data = list(collection.find(query, {"_id": 0}).sort("timestamp", -1).limit(safe_limit))
    data.reverse()

    if floor or machine:
        filtered = []
        for row in data:
            meter_events = row.get("meter_events", [])
            if floor:
                meter_events = [event for event in meter_events if event.get("floor") == floor]
            if machine:
                meter_events = [event for event in meter_events if event.get("machine") == machine]

            if meter_events:
                floor_agg = {}
                machine_agg = {}
                source_floors = row.get("aggregations", {}).get("floors", {})
                for event in meter_events:
                    floor_path = f"{event.get('organization')}/{event.get('building')}/{event.get('floor')}"
                    machine_path = (
                        f"{event.get('organization')}/{event.get('building')}/"
                        f"{event.get('floor')}/{event.get('machine')}"
                    )

                    floor_agg.setdefault(
                        floor_path,
                        {
                            "organization": event.get("organization"),
                            "building": event.get("building"),
                            "floor": event.get("floor"),
                            "energy_consumption": 0.0,
                            "water_consumption": 0.0,
                            "machines": 0,
                            "avg_temperature": source_floors.get(floor_path, {}).get("avg_temperature", 0.0),
                            "avg_humidity": source_floors.get(floor_path, {}).get("avg_humidity", 0.0),
                            "avg_co2": source_floors.get(floor_path, {}).get("avg_co2", 0.0),
                            "occupancy": source_floors.get(floor_path, {}).get("occupancy", 0),
                        },
                    )

                    floor_agg[floor_path]["machines"] += 1
                    if event.get("meter_type") == "energy":
                        floor_agg[floor_path]["energy_consumption"] += float(
                            event.get("consumption", 0)
                        )
                    elif event.get("meter_type") == "water":
                        floor_agg[floor_path]["water_consumption"] += float(
                            event.get("consumption", 0)
                        )

                    machine_agg[machine_path] = {
                        "organization": event.get("organization"),
                        "building": event.get("building"),
                        "floor": event.get("floor"),
                        "machine": event.get("machine"),
                        "meter_type": event.get("meter_type"),
                        "consumption": round(float(event.get("consumption", 0)), 2),
                        "current_reading": round(float(event.get("current_reading", 0)), 2),
                    }

                for floor_path in floor_agg:
                    floor_agg[floor_path]["energy_consumption"] = round(
                        floor_agg[floor_path]["energy_consumption"], 2
                    )
                    floor_agg[floor_path]["water_consumption"] = round(
                        floor_agg[floor_path]["water_consumption"], 2
                    )

                clone = dict(row)
                clone["meter_events"] = meter_events
                clone["overall"] = {
                    "energy_consumption": round(
                        sum(
                            event.get("consumption", 0)
                            for event in meter_events
                            if event.get("meter_type") == "energy"
                        ),
                        2,
                    ),
                    "water_consumption": round(
                        sum(
                            event.get("consumption", 0)
                            for event in meter_events
                            if event.get("meter_type") == "water"
                        ),
                        2,
                    ),
                }
                clone["aggregations"] = {
                    "building": row.get("aggregations", {}).get("building", {}),
                    "floors": floor_agg,
                    "machines": machine_agg,
                }
                filtered.append(clone)
        data = filtered

    return {"data": data}


@app.get("/combinations")
def get_combinations():
    rows = list(
        collection.find(
            {},
            {
                "_id": 0,
                "organization": 1,
                "building": 1,
                "meter_events.organization": 1,
                "meter_events.building": 1,
                "meter_events.floor": 1,
                "meter_events.machine": 1,
                "meter_events.meter_type": 1,
            },
        ).sort("timestamp", -1).limit(500)
    )

    organizations = set()
    buildings = set()
    floors = set()
    machines = set()
    hierarchy = {}

    for row in rows:
        if row.get("organization"):
            organizations.add(row["organization"])
        if row.get("building"):
            buildings.add(row["building"])

        row_org = row.get("organization")
        row_building = row.get("building")
        if row_org and row_building:
            hierarchy.setdefault(row_org, {}).setdefault(
                row_building,
                {
                    "floors": set(),
                    "floor_machines": {},
                    "floor_machines_by_type": {},
                },
            )

        for event in row.get("meter_events", []):
            if event.get("organization"):
                organizations.add(event["organization"])
            if event.get("building"):
                buildings.add(event["building"])
            if event.get("floor"):
                floors.add(event["floor"])
            if event.get("machine"):
                machines.add(event["machine"])

            org = event.get("organization") or row_org
            building = event.get("building") or row_building
            floor = event.get("floor")
            machine = event.get("machine")
            meter_type = event.get("meter_type")

            if not org or not building or not floor:
                continue

            hierarchy.setdefault(org, {}).setdefault(
                building,
                {
                    "floors": set(),
                    "floor_machines": {},
                    "floor_machines_by_type": {},
                },
            )
            hierarchy[org][building]["floors"].add(floor)
            hierarchy[org][building]["floor_machines"].setdefault(floor, set())
            hierarchy[org][building]["floor_machines_by_type"].setdefault(
                floor,
                {"energy": set(), "water": set(), "other": set()},
            )
            if machine:
                hierarchy[org][building]["floor_machines"][floor].add(machine)
                typed_bucket = meter_type if meter_type in {"energy", "water"} else "other"
                hierarchy[org][building]["floor_machines_by_type"][floor][typed_bucket].add(
                    machine
                )

    normalized_hierarchy = {}
    for org, org_payload in hierarchy.items():
        normalized_hierarchy[org] = {}
        for building, building_payload in org_payload.items():
            normalized_hierarchy[org][building] = {
                "floors": sorted(building_payload["floors"]),
                "floor_machines": {
                    floor: sorted(machine_set)
                    for floor, machine_set in building_payload["floor_machines"].items()
                },
                "floor_machines_by_type": {
                    floor: {
                        "energy": sorted(type_payload["energy"]),
                        "water": sorted(type_payload["water"]),
                        "other": sorted(type_payload["other"]),
                    }
                    for floor, type_payload in building_payload["floor_machines_by_type"].items()
                },
            }

    return {
        "organizations": sorted(organizations),
        "buildings": sorted(buildings),
        "floors": sorted(floors),
        "machines": sorted(machines),
        "hierarchy": normalized_hierarchy,
    }