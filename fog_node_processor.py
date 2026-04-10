import json
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import paho.mqtt.client as mqtt
import requests

BROKER = "localhost"
TOPIC = "building/sensors"
CLOUD_API = "http://localhost:8000/sensor-data"

# Track previous cumulative meter values to derive per-interval consumption.
previous_meter_values = {}


def get_app_timezone():
    try:
        return ZoneInfo("Europe/Dublin")
    except ZoneInfoNotFoundError:
        return datetime.now().astimezone().tzinfo


APP_TIMEZONE = get_app_timezone()


def parse_param_path(path):
    parts = path.split("/")
    if len(parts) != 4:
        raise ValueError(f"Invalid meter path: {path}")
    return {
        "organization": parts[0],
        "building": parts[1],
        "floor": parts[2],
        "machine": parts[3],
    }


def classify_meter(machine_name):
    lower = machine_name.lower()
    if "energy" in lower:
        return "energy"
    if "water" in lower:
        return "water"
    return "other"


def parse_sensor_payload(sensors_map):
    floor_sensors = {}
    for path, value in sensors_map.items():
        try:
            identity = parse_param_path(path)
        except ValueError:
            continue
        floor_key = f"{identity['organization']}/{identity['building']}/{identity['floor']}"
        floor_sensors.setdefault(floor_key, {})[identity["machine"]] = value
    return floor_sensors


def process_sensor_data(data):
    meters = data.get("meters", {})
    sensors = data.get("sensors", {})

    floor_sensors = parse_sensor_payload(sensors)

    overall_energy = 0.0
    overall_water = 0.0
    floors = {}
    machines = {}
    meter_events = []
    alerts = []

    for path, current_value in meters.items():
        try:
            identity = parse_param_path(path)
        except ValueError:
            continue

        meter_type = classify_meter(identity["machine"])
        previous_value = previous_meter_values.get(path)
        if previous_value is None:
            consumption = 0.0
        else:
            consumption = max(0.0, float(current_value) - float(previous_value))
        previous_meter_values[path] = float(current_value)

        meter_key = (
            f"{identity['organization']}/{identity['building']}/"
            f"{identity['floor']}/{identity['machine']}"
        )
        floor_key = f"{identity['organization']}/{identity['building']}/{identity['floor']}"

        machines[meter_key] = {
            "organization": identity["organization"],
            "building": identity["building"],
            "floor": identity["floor"],
            "machine": identity["machine"],
            "meter_type": meter_type,
            "consumption": round(consumption, 2),
            "current_reading": round(float(current_value), 2),
        }

        floors.setdefault(
            floor_key,
            {
                "organization": identity["organization"],
                "building": identity["building"],
                "floor": identity["floor"],
                "energy_consumption": 0.0,
                "water_consumption": 0.0,
                "machines": 0,
            },
        )
        floors[floor_key]["machines"] += 1

        if meter_type == "energy":
            floors[floor_key]["energy_consumption"] += consumption
            overall_energy += consumption
        elif meter_type == "water":
            floors[floor_key]["water_consumption"] += consumption
            overall_water += consumption

        meter_events.append(
            {
                "organization": identity["organization"],
                "building": identity["building"],
                "floor": identity["floor"],
                "machine": identity["machine"],
                "meter_type": meter_type,
                "consumption": round(consumption, 2),
                "current_reading": round(float(current_value), 2),
                "path": meter_key,
            }
        )

    for floor_key, floor_readings in floor_sensors.items():
        occupancy = float(floor_readings.get("occupancy", 0))
        co2 = float(floor_readings.get("co2", 0))
        temperature = float(floor_readings.get("temperature", 0))

        floor_bucket = floors.get(floor_key)
        if floor_bucket is None:
            continue

        floor_bucket["avg_temperature"] = round(temperature, 2)
        floor_bucket["avg_humidity"] = round(float(floor_readings.get("humidity", 0)), 2)
        floor_bucket["avg_co2"] = round(co2, 2)
        floor_bucket["occupancy"] = int(occupancy)

        if occupancy == 0 and floor_bucket["energy_consumption"] > 0.8:
            alerts.append(f"energy_waste_detected:{floor_key}")
        if occupancy == 0 and floor_bucket["water_consumption"] > 2.0:
            alerts.append(f"possible_water_leak:{floor_key}")
        if co2 > 1000:
            alerts.append(f"poor_air_quality:{floor_key}")
        if temperature > 28:
            alerts.append(f"high_temperature:{floor_key}")

    for floor_key in floors:
        floors[floor_key]["energy_consumption"] = round(
            floors[floor_key]["energy_consumption"], 2
        )
        floors[floor_key]["water_consumption"] = round(
            floors[floor_key]["water_consumption"], 2
        )

    processed_timestamp = datetime.now(APP_TIMEZONE).isoformat()
    processed_data = {
        "timestamp": processed_timestamp,
        "organization": data.get("organization", "NCI"),
        "building": data.get("building", "Mayer_Square"),
        "meter_params": data.get("meter_params", []),
        "sensor_params": data.get("sensor_params", []),
        "overall": {
            "energy_consumption": round(overall_energy, 2),
            "water_consumption": round(overall_water, 2),
        },
        "aggregations": {
            "building": {
                f"{data.get('organization', 'NCI')}/{data.get('building', 'Mayer_Square')}": {
                    "energy_consumption": round(overall_energy, 2),
                    "water_consumption": round(overall_water, 2),
                }
            },
            "floors": floors,
            "machines": machines,
        },
        "meter_events": meter_events,
        "alerts": alerts,
    }

    print("Processed Data:", processed_data)

    try:
        requests.post(CLOUD_API, json=processed_data, timeout=2)
    except Exception:
        print("Cloud backend not available yet")


def on_connect(client, userdata, flags, rc):
    print("Connected to MQTT Broker")
    client.subscribe(TOPIC)


def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        process_sensor_data(data)
    except Exception as error:
        print("Error processing message:", error)


client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message

client.connect(BROKER)
client.loop_forever()