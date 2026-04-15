import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from pymongo import MongoClient
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

app = FastAPI()

app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("APP_SECRET_KEY", "edge-dashboard-dev-secret-change-me"),
    session_cookie="edge_dashboard_session",
    max_age=60 * 60 * 8,
    https_only=False,
    same_site="lax",
)

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

AUTH_USERNAME = os.getenv("DASHBOARD_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "admin123")

WINDOW_LOOKBACKS = {
    "minute": timedelta(hours=1),
    "hourly": timedelta(days=2),
    "daily": timedelta(days=60),
    "monthly": timedelta(days=365),
    "yearly": timedelta(days=3650),
}

WINDOW_MAX_LIMITS = {
    "minute": 120,
    "hourly": 800,
    "daily": 1500,
    "monthly": 2500,
    "yearly": 3000,
}


def parse_iso_timestamp(timestamp_str: str) -> datetime | None:
    if not timestamp_str:
        return None
    try:
        return datetime.fromisoformat(timestamp_str)
    except ValueError:
        return None


def get_row_metric_value(row: dict, metric: str) -> float:
    if metric in {"energy_consumption", "water_consumption"}:
        return float(row.get("overall", {}).get(metric, 0) or 0)

    floor_data = row.get("aggregations", {}).get("floors", {})
    if not isinstance(floor_data, dict) or not floor_data:
        return 0.0

    metric_field = {
        "avg_co2": "avg_co2",
        "avg_temperature": "avg_temperature",
        "avg_humidity": "avg_humidity",
        "occupancy": "occupancy",
    }.get(metric)
    if not metric_field:
        return 0.0

    values = [float(floor.get(metric_field, 0) or 0) for floor in floor_data.values()]
    return sum(values) / len(values) if values else 0.0


def filter_meter_events(row: dict, floor: str | None, machine: str | None) -> list:
    meter_events = row.get("meter_events", [])
    if not meter_events:
        return []

    filtered_events = meter_events
    if floor:
        filtered_events = [event for event in filtered_events if event.get("floor") == floor]
    if machine:
        filtered_events = [event for event in filtered_events if event.get("machine") == machine]

    return filtered_events


def rebuild_filtered_row(row: dict, floor: str | None, machine: str | None) -> dict | None:
    meter_events = filter_meter_events(row, floor, machine)
    if not meter_events:
        return None

    source_floors = row.get("aggregations", {}).get("floors", {})
    floor_agg = {}
    machine_agg = {}

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
            floor_agg[floor_path]["energy_consumption"] += float(event.get("consumption", 0))
        elif event.get("meter_type") == "water":
            floor_agg[floor_path]["water_consumption"] += float(event.get("consumption", 0))

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
    return clone


def get_authenticated_user(request: Request) -> str | None:
    user = request.session.get("user")
    return user if isinstance(user, str) and user else None


def require_authenticated_user(request: Request) -> str:
    user = get_authenticated_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


@app.on_event("startup")
def ensure_indexes():
    # These indexes keep dashboard filter + sort queries responsive as history grows.
    collection.create_index([("timestamp", -1)])
    collection.create_index([("organization", 1), ("building", 1), ("timestamp", -1)])
    collection.create_index([("meter_events.floor", 1), ("timestamp", -1)])
    collection.create_index([("meter_events.machine", 1), ("timestamp", -1)])


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    user = get_authenticated_user(request)
    if user:
        return RedirectResponse(url="/", status_code=302)
    return templates.TemplateResponse(request=request, name="login.html", context={})


@app.post("/api/login")
async def login(request: Request):
    payload = await request.json()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))

    if username == AUTH_USERNAME and password == AUTH_PASSWORD:
        request.session.clear()
        request.session["user"] = username
        request.session["signed_in_at"] = datetime.now(APP_TIMEZONE).isoformat()
        return {"status": "ok", "username": username}

    return JSONResponse(
        status_code=401,
        content={"status": "error", "message": "Invalid username or password"},
    )


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    user = get_authenticated_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={"username": user},
    )

@app.post("/sensor-data")
def receive_data(data: dict):
    data["received_at"] = datetime.now(APP_TIMEZONE).isoformat()
    collection.insert_one(data)
    return {"status": "stored"}

@app.get("/data")
def get_data(
    request: Request,
    organization: str | None = None,
    building: str | None = None,
    floor: str | None = None,
    machine: str | None = None,
    window: str = "hourly",
    limit: int = 300,
):
    require_authenticated_user(request)
    query = {}
    if organization:
        query["organization"] = organization
    if building:
        query["building"] = building

    window_start = None
    if window in WINDOW_LOOKBACKS:
        window_start = datetime.now(APP_TIMEZONE) - WINDOW_LOOKBACKS[window]
        query["timestamp"] = {"$gte": window_start.isoformat()}

    max_limit = WINDOW_MAX_LIMITS.get(window, 3000)
    safe_limit = max(1, min(limit, max_limit))
    data = list(collection.find(query, {"_id": 0}).sort("timestamp", -1).limit(safe_limit))
    data.reverse()

    if floor or machine:
        filtered = []
        for row in data:
            filtered_row = rebuild_filtered_row(row, floor, machine)
            if filtered_row is not None:
                filtered.append(filtered_row)
        data = filtered

    return {"data": data}


@app.get("/trend")
def get_trend(
    request: Request,
    organization: str | None = None,
    building: str | None = None,
    floor: str | None = None,
    machine: str | None = None,
    metric: str = "energy_consumption",
    window: str = "hourly",
    limit: int = 300,
):
    require_authenticated_user(request)
    query = {}
    if organization:
        query["organization"] = organization
    if building:
        query["building"] = building

    if floor or machine:
        elem_query = {}
        if floor:
            elem_query["floor"] = floor
        if machine:
            elem_query["machine"] = machine
        query["meter_events"] = {"$elemMatch": elem_query}

    if window in WINDOW_LOOKBACKS:
        window_start = datetime.now(APP_TIMEZONE) - WINDOW_LOOKBACKS[window]
        query["timestamp"] = {"$gte": window_start.isoformat()}

    max_limit = WINDOW_MAX_LIMITS.get(window, 3000)
    safe_limit = max(1, min(limit, max_limit))
    rows = list(collection.find(query, {"_id": 0}).sort("timestamp", -1).limit(safe_limit))
    rows.reverse()

    if floor or machine:
        filtered_rows = []
        for row in rows:
            filtered_row = rebuild_filtered_row(row, floor, machine)
            if filtered_row is not None:
                filtered_rows.append(filtered_row)
        rows = filtered_rows

    buckets: dict[str, dict[str, float | str]] = {}
    for row in rows:
        ts = parse_iso_timestamp(row.get("timestamp"))
        if ts is None:
            continue

        if window == "minute":
            key = ts.strftime("%Y-%m-%d %H:%M")
            label = ts.strftime("%d/%m %H:%M")
        elif window == "hourly":
            key = ts.strftime("%Y-%m-%d %H")
            label = ts.strftime("%d/%m %H:00")
        elif window == "daily":
            key = ts.strftime("%Y-%m-%d")
            label = ts.strftime("%d/%m/%Y")
        elif window == "monthly":
            key = ts.strftime("%Y-%m")
            label = ts.strftime("%m/%Y")
        else:
            key = ts.strftime("%Y")
            label = ts.strftime("%Y")

        bucket = buckets.setdefault(key, {"label": label, "total": 0.0, "count": 0})
        bucket["total"] += get_row_metric_value(row, metric)
        bucket["count"] += 1

    ordered_keys = sorted(buckets.keys())
    labels = [buckets[key]["label"] for key in ordered_keys]
    values = [
        round(
            buckets[key]["total"] / buckets[key]["count"]
            if metric not in {"energy_consumption", "water_consumption"}
            else buckets[key]["total"],
            2,
        )
        for key in ordered_keys
    ]

    return {"labels": labels, "values": values}


@app.get("/floor-aggregation")
def get_floor_aggregation(
    request: Request,
    organization: str | None = None,
    building: str | None = None,
    floor: str | None = None,
    machine: str | None = None,
    metric: str = "energy_consumption",
    window: str = "hourly",
    limit: int = 300,
):
    require_authenticated_user(request)
    query = {}
    if organization:
        query["organization"] = organization
    if building:
        query["building"] = building

    if floor or machine:
        elem_query = {}
        if floor:
            elem_query["floor"] = floor
        if machine:
            elem_query["machine"] = machine
        query["meter_events"] = {"$elemMatch": elem_query}

    if window in WINDOW_LOOKBACKS:
        window_start = datetime.now(APP_TIMEZONE) - WINDOW_LOOKBACKS[window]
        query["timestamp"] = {"$gte": window_start.isoformat()}

    max_limit = WINDOW_MAX_LIMITS.get(window, 3000)
    safe_limit = max(1, min(limit, max_limit))
    rows = list(collection.find(query, {"_id": 0}).sort("timestamp", -1).limit(safe_limit))
    rows.reverse()

    if floor or machine:
        filtered_rows = []
        for row in rows:
            filtered_row = rebuild_filtered_row(row, floor, machine)
            if filtered_row is not None:
                filtered_rows.append(filtered_row)
        rows = filtered_rows

    metric_field = {
        "energy_consumption": "energy_consumption",
        "water_consumption": "water_consumption",
        "avg_co2": "avg_co2",
        "avg_temperature": "avg_temperature",
        "avg_humidity": "avg_humidity",
        "occupancy": "occupancy",
    }.get(metric, "energy_consumption")

    floor_totals: dict[str, dict[str, float | int | str]] = {}
    for row in rows:
        floors = row.get("aggregations", {}).get("floors", {}) or {}
        for path, values in floors.items():
            if path not in floor_totals:
                floor_totals[path] = {"label": path.split("/")[-1], "total": 0.0, "count": 0}
            floor_totals[path]["total"] += float(values.get(metric_field, 0) or 0)
            floor_totals[path]["count"] += 1

    sorted_paths = sorted(floor_totals.keys())
    labels = [floor_totals[path]["label"] for path in sorted_paths]
    values = [
        round(
            floor_totals[path]["total"] / floor_totals[path]["count"]
            if metric not in {"energy_consumption", "water_consumption"}
            else floor_totals[path]["total"],
            2,
        )
        for path in sorted_paths
    ]

    return {"labels": labels, "values": values}


@app.get("/family-aggregation")
def get_family_aggregation(
    request: Request,
    organization: str | None = None,
    building: str | None = None,
    floor: str | None = None,
    machine: str | None = None,
    metric: str = "energy_consumption",
    window: str = "hourly",
    limit: int = 300,
):
    require_authenticated_user(request)
    wanted_type = "energy" if metric == "energy_consumption" else "water" if metric == "water_consumption" else None
    if not wanted_type:
        return {"labels": [], "values": []}

    query = {}
    if organization:
        query["organization"] = organization
    if building:
        query["building"] = building

    if floor or machine:
        elem_query = {}
        if floor:
            elem_query["floor"] = floor
        if machine:
            elem_query["machine"] = machine
        query["meter_events"] = {"$elemMatch": elem_query}

    if window in WINDOW_LOOKBACKS:
        window_start = datetime.now(APP_TIMEZONE) - WINDOW_LOOKBACKS[window]
        query["timestamp"] = {"$gte": window_start.isoformat()}

    max_limit = WINDOW_MAX_LIMITS.get(window, 3000)
    safe_limit = max(1, min(limit, max_limit))
    rows = list(collection.find(query, {"_id": 0}).sort("timestamp", -1).limit(safe_limit))
    rows.reverse()

    if floor or machine:
        filtered_rows = []
        for row in rows:
            filtered_row = rebuild_filtered_row(row, floor, machine)
            if filtered_row is not None:
                filtered_rows.append(filtered_row)
        rows = filtered_rows

    family_totals: dict[str, float] = {}
    for row in rows:
        for event in row.get("meter_events", []):
            if event.get("meter_type") != wanted_type:
                continue
            family = event.get("machine")
            if not family:
                continue
            family = family.rsplit("_", 1)[0]
            family_totals[family] = family_totals.get(family, 0) + float(event.get("consumption", 0) or 0)

    sorted_families = sorted(family_totals.keys())
    labels = sorted_families
    values = [round(family_totals[family], 2) for family in sorted_families]

    return {"labels": labels, "values": values}


@app.get("/combinations")
def get_combinations(request: Request):
    require_authenticated_user(request)
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


@app.get("/api/stats")
def get_collection_stats(request: Request):
    require_authenticated_user(request)
    stats = {
        "total_documents": collection.count_documents({}),
        "index_count": sum(1 for _ in collection.list_indexes()),
    }
    return stats


@app.delete("/api/clear-data")
def clear_all_data(request: Request):
    require_authenticated_user(request)
    result = collection.delete_many({})
    return {
        "status": "success",
        "deleted_count": result.deleted_count,
        "message": f"Deleted {result.deleted_count} sensor data records"
    }