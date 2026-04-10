import json
import random
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER = "localhost"
TOPIC = "building/sensors"
ORGANIZATION = "NCI"
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

client = mqtt.Client()
client.connect(BROKER)


def meter_key(building_name, floor, machine_name):
    return f"{ORGANIZATION}/{building_name}/{floor}/{machine_name}"


meter_state = {}

# Initialize cumulative meter counters so fog node can compute deltas.
for building_name in BUILDINGS:
    for floor_name, machine_name in ENERGY_METERS:
        meter_state[meter_key(building_name, floor_name, machine_name)] = round(
            random.uniform(40.0, 110.0), 2
        )

    for floor_name, machine_name in WATER_METERS:
        meter_state[meter_key(building_name, floor_name, machine_name)] = round(
            random.uniform(220.0, 600.0), 2
        )


def occupancy_for_floor():
    return random.choice([0, 1])


def sensor_value(metric_name, occupied):
    if metric_name == "temperature":
        return round(random.uniform(22.0, 29.0) + (0.4 if occupied else -0.2), 2)
    if metric_name == "humidity":
        return round(random.uniform(38.0, 68.0), 2)
    if metric_name == "co2":
        return random.randint(450, 1250) if occupied else random.randint(380, 820)
    return occupied


while True:
    for building_name in BUILDINGS:
        floor_occupancy = {
            "F1": occupancy_for_floor(),
            "F2": occupancy_for_floor(),
            "F3": occupancy_for_floor(),
        }

        meters = {}
        for floor_name, machine_name in ENERGY_METERS:
            key = meter_key(building_name, floor_name, machine_name)
            increment = (
                random.uniform(0.14, 0.28)
                if floor_occupancy[floor_name]
                else random.uniform(0.05, 0.12)
            )
            meter_state[key] = round(meter_state[key] + increment, 2)
            meters[key] = meter_state[key]

        for floor_name, machine_name in WATER_METERS:
            key = meter_key(building_name, floor_name, machine_name)
            increment = (
                random.uniform(0.45, 1.05)
                if floor_occupancy[floor_name]
                else random.uniform(0.16, 0.42)
            )
            meter_state[key] = round(meter_state[key] + increment, 2)
            meters[key] = meter_state[key]

        sensors = {}
        for floor_name in floor_occupancy:
            occupied = floor_occupancy[floor_name]
            sensors[meter_key(building_name, floor_name, "temperature")] = sensor_value(
                "temperature", occupied
            )
            sensors[meter_key(building_name, floor_name, "humidity")] = sensor_value(
                "humidity", occupied
            )
            sensors[meter_key(building_name, floor_name, "co2")] = sensor_value(
                "co2", occupied
            )
            sensors[meter_key(building_name, floor_name, "occupancy")] = sensor_value(
                "occupancy", occupied
            )

        data = {
            "timestamp": datetime.utcnow().isoformat(),
            "organization": ORGANIZATION,
            "building": building_name,
            "meter_params": [f"{key}:{value}" for key, value in meters.items()],
            "sensor_params": [f"{key}:{value}" for key, value in sensors.items()],
            "meters": meters,
            "sensors": sensors,
        }

        client.publish(TOPIC, json.dumps(data))
        print("Sensor Data Sent:", data)

    time.sleep(3)