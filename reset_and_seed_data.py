import argparse
import random
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient

DB_NAME = "smart_building"
COLLECTION_NAME = "sensor_data"
ORG = "NCI"
BUILDINGS = ["Mayer_Square", "Spencer_Dock"]

ENERGY_METERS = [
    ("F1", "heater_energy_1"),
    ("F1", "lighting_energy_1"),
    ("F1", "hvac_energy_1"),
    ("F1", "server_rack_energy_1"),
    ("F2", "heater_energy_2"),
    ("F2", "lighting_energy_2"),
    ("F2", "hvac_energy_2"),
    ("F2", "printer_room_energy_2"),
    ("F3", "heater_energy_3"),
    ("F3", "lighting_energy_3"),
]

WATER_METERS = [
    ("F1", "pantry_water_1"),
    ("F1", "restroom_water_1"),
    ("F1", "cooling_tower_water_1"),
    ("F1", "cleaning_water_1"),
    ("F2", "pantry_water_2"),
    ("F2", "restroom_water_2"),
    ("F2", "cooling_tower_water_2"),
    ("F2", "cleaning_water_2"),
    ("F3", "restroom_water_3"),
    ("F3", "pantry_water_3"),
]


def machine_path(building_name, floor_name, machine_name):
    return f"{ORG}/{building_name}/{floor_name}/{machine_name}"


def generate_document(base_time, index, building_name):
    floors = {}
    machines = {}
    events = []
    total_energy = 0.0
    total_water = 0.0

    for floor_name, machine_name in ENERGY_METERS + WATER_METERS:
        meter_type = "energy" if "energy" in machine_name else "water"
        consumption = round(random.uniform(0.08, 0.42), 2) if meter_type == "energy" else round(random.uniform(0.2, 1.2), 2)
        reading = round(50 + index + random.uniform(10.0, 300.0), 2)

        floor_key = f"{ORG}/{building_name}/{floor_name}"
        machine_key = machine_path(building_name, floor_name, machine_name)

        floors.setdefault(
            floor_key,
            {
                "organization": ORG,
                "building": building_name,
                "floor": floor_name,
                "energy_consumption": 0.0,
                "water_consumption": 0.0,
                "machines": 0,
            },
        )
        floors[floor_key]["machines"] += 1

        if meter_type == "energy":
            floors[floor_key]["energy_consumption"] += consumption
            total_energy += consumption
        else:
            floors[floor_key]["water_consumption"] += consumption
            total_water += consumption

        machines[machine_key] = {
            "organization": ORG,
            "building": building_name,
            "floor": floor_name,
            "machine": machine_name,
            "meter_type": meter_type,
            "consumption": consumption,
            "current_reading": reading,
        }

        events.append(
            {
                "organization": ORG,
                "building": building_name,
                "floor": floor_name,
                "machine": machine_name,
                "meter_type": meter_type,
                "consumption": consumption,
                "current_reading": reading,
                "path": machine_key,
            }
        )

    timestamp = (base_time + timedelta(seconds=index * 20)).isoformat()

    return {
        "timestamp": timestamp,
        "organization": ORG,
        "building": building_name,
        "meter_params": [f"{event['path']}:{event['current_reading']}" for event in events],
        "sensor_params": [],
        "overall": {
            "energy_consumption": round(total_energy, 2),
            "water_consumption": round(total_water, 2),
        },
        "aggregations": {
            "building": {
                f"{ORG}/{building_name}": {
                    "energy_consumption": round(total_energy, 2),
                    "water_consumption": round(total_water, 2),
                }
            },
            "floors": floors,
            "machines": machines,
        },
        "meter_events": events,
        "alerts": [],
        "received_at": timestamp,
    }


def main():
    parser = argparse.ArgumentParser(description="Reset and seed smart_building.sensor_data")
    parser.add_argument("--mongo-uri", default="mongodb://localhost:27017/")
    parser.add_argument("--seed-count", type=int, default=20)
    args = parser.parse_args()

    client = MongoClient(args.mongo_uri)
    collection = client[DB_NAME][COLLECTION_NAME]

    deleted = collection.delete_many({}).deleted_count
    print(f"Deleted existing records: {deleted}")

    docs = []
    if args.seed_count > 0:
        start = datetime.now(timezone.utc) - timedelta(minutes=10)
        docs = [
            generate_document(start, i, building_name)
            for i in range(args.seed_count)
            for building_name in BUILDINGS
        ]
        collection.insert_many(docs)

    print(f"Inserted seed records: {len(docs)}")
    print("Done. Your dashboard now starts with clean NCI 20-meter schema data.")


if __name__ == "__main__":
    main()
