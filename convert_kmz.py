import zipfile
import xml.etree.ElementTree as ET
import json
import os

STATIONS = [
    "Universitet xiyoboni stansiyasi.kmz",
    "Turizm kolleji stansiyasi.kmz",
    "Registon stansiyasi.kmz",
    "Muzey stansiyasi.kmz",
    "Dahbed stansiyasi.kmz",
]

COLORS = ["#e74c3c", "#e67e22", "#2ecc71", "#9b59b6", "#3498db"]

results = []
for idx, kmz_file in enumerate(STATIONS):
    with zipfile.ZipFile(kmz_file) as z:
        kml = z.read("doc.kml").decode("utf-8")
    root = ET.fromstring(kml)
    ns = {"kml": "http://www.opengis.net/kml/2.2"}
    for pm in root.findall(".//kml:Placemark", ns):
        name_el = pm.find("kml:name", ns)
        coords_el = pm.find(".//kml:coordinates", ns)
        if coords_el is not None:
            parts = coords_el.text.strip().split(",")
            lon, lat = float(parts[0]), float(parts[1])
            name = name_el.text.strip() if name_el is not None else kmz_file.replace(".kmz", "")
            results.append({
                "name": name,
                "lon": lon,
                "lat": lat,
                "color": COLORS[idx % len(COLORS)],
            })
            print(f"  {name}: lon={lon}, lat={lat}")

geojson = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
            "properties": {"name": s["name"], "color": s["color"]},
        }
        for s in results
    ],
}

out_path = os.path.join("data", "stations.geojson")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(geojson, f, ensure_ascii=False, indent=2)

print(f"\nSaqlandi: {out_path}")
