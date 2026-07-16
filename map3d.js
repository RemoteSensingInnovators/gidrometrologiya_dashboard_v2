// 3D city scene rendered with Three.js WebGPURenderer (falls back to WebGL2
// automatically when WebGPU isn't available). Buildings are extruded from
// buildings.geojson, clipped to the Samarqand city border, colored by the
// selected pollutant's proximity-weighted intensity, and a GPU-rendered
// particle field simulates wind flowing through the cityscape.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX_STATION_DIST = 4500; // meters — color falloff radius around a station
const BUILDING_CAP = 45000; // keep load time + frame rate reasonable
const RISE_DURATION = 2400; // ms
const PARTICLE_COUNT = 900; // each particle renders as TRAIL_LEN-1 instanced segments
const WIND_BOUNDS_MARGIN = 250; // meters beyond boundary bbox
const BASEMAP_ZOOM = 15;
const BASEMAP_TILE_URL = (z, x, y) => `osmtiles/${z}/${x}/${y}.png`;

const POLLUTANT_HUES = {
  SO2: 205, NO2: 275, NH3: 135, HF: 320, NO: 28, Fenol: 355, CO: 45, CL: 165, Chang: 95,
};

let renderer, scene, camera, controls, container;
let buildingsMesh = null;
let buildingRanges = []; // [{ start, count, distNorm }]
let boundaryGeometry = null;
let centerLonLat = [66.9, 39.6];
let map3dDataStore = null;
let stationCoordsLocal = [];
let currentIntensity = 0;
let windPoints = null; // THREE.LineSegments — curving, fading flow-trail mesh
let windPhases = null;
let windBounds = { minX: -800, maxX: 800, minZ: -800, maxZ: 800 };
let windVector = { x: 0, z: -1, speed: 0 };
let windHue = 205;
let rotating = true;
let isFlying = false;
let tourStops = [];
let tourIndex = -1;
let tourTimer = null;
let lastSelectorKey = '';
const sceneStartTime = performance.now();

// ---------- geometry helpers (lon/lat) ----------

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonContains(rings, lon, lat) {
  if (!ringContains(rings[0], lon, lat)) return false;
  for (let h = 1; h < rings.length; h++) {
    if (ringContains(rings[h], lon, lat)) return false;
  }
  return true;
}

function boundaryContains(geometry, lon, lat) {
  if (!geometry) return true;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    if (polygonContains(poly, lon, lat)) return true;
  }
  return false;
}

function geometryBounds(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

function allOuterRings(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.map((poly) => poly[0]);
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function firstRing(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates[0] || null;
  if (geom.type === 'MultiPolygon') return (geom.coordinates[0] && geom.coordinates[0][0]) || null;
  return null;
}

function ringAreaAndCentroid(ring) {
  let area = 0, cx = 0, cy = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    const x0 = ring[i][0], y0 = ring[i][1];
    const x1 = ring[i + 1][0], y1 = ring[i + 1][1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) return { area: 0, lon: ring[0][0], lat: ring[0][1] };
  return { area: Math.abs(area), lon: cx / (6 * area), lat: cy / (6 * area) };
}

function ringMinDimensionMeters(ring, lat) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, la] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
  }
  const widthM = (maxLon - minLon) * 111320 * Math.cos((lat * Math.PI) / 180);
  const heightM = (maxLat - minLat) * 110540;
  return Math.min(widthM, heightM);
}

function metersBetween(lon1, lat1, lon2, lat2) {
  const midLat = ((lat1 + lat2) / 2) * Math.PI / 180;
  const dx = (lon1 - lon2) * 111320 * Math.cos(midLat);
  const dy = (lat1 - lat2) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestStationDist(lon, lat, stationLonLat) {
  let best = Infinity;
  for (const [slon, slat] of stationLonLat) {
    const d = metersBetween(lon, lat, slon, slat);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : MAX_STATION_DIST;
}

// local projection: x = east meters, z = south meters (so -z is north)
function toLocal(lon, lat) {
  const x = (lon - centerLonLat[0]) * 111320 * Math.cos((centerLonLat[1] * Math.PI) / 180);
  const z = -(lat - centerLonLat[1]) * 110540;
  return [x, z];
}

// ---------- data processing ----------

function processBuildings(rawGeojson, stationLonLat) {
  const records = [];
  const src = rawGeojson.features || [];
  for (let i = 0; i < src.length; i++) {
    const ring = firstRing(src[i].geometry);
    if (!ring || ring.length < 4) continue;

    const { area, lon, lat } = ringAreaAndCentroid(ring);
    if (!boundaryContains(boundaryGeometry, lon, lat)) continue;
    if (ringMinDimensionMeters(ring, lat) < 1.8) continue;

    const areaM2 = area * (111320 * Math.cos((lat * Math.PI) / 180)) * 110540;
    const jitter = hashString(src[i].properties?.full_id || String(i)) % 9;
    const height = Math.min(72, Math.max(6, 6 + Math.sqrt(Math.max(areaM2, 1)) * 0.55 + jitter));

    const dist = nearestStationDist(lon, lat, stationLonLat);
    const distNorm = Math.min(1, dist / MAX_STATION_DIST);

    // shape's local "y" is negated so the extrude+rotateX(-90deg) step lands on the correct world Z
    const points = ring.map(([rlon, rlat]) => {
      const [x, z] = toLocal(rlon, rlat);
      return [x, -z];
    });

    records.push({ points, height, distNorm });
  }

  if (records.length > BUILDING_CAP) {
    const stride = Math.ceil(records.length / BUILDING_CAP);
    return records.filter((_, idx) => idx % stride === 0);
  }
  return records;
}

function colorForBuilding(distNorm, intensity) {
  const score = Math.max(0, Math.min(1, (1 - distNorm) * intensity));
  const stops = [
    [0, [0.18, 0.80, 0.44]],
    [0.25, [0.95, 0.77, 0.06]],
    [0.55, [0.90, 0.49, 0.13]],
    [1, [0.91, 0.30, 0.24]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1];
    const [t1, c1] = stops[i];
    if (score <= t1) {
      const f = (score - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  const last = stops[stops.length - 1][1];
  return last;
}

function buildBuildingsMesh(records) {
  const geometries = [];
  buildingRanges = [];
  let vertexOffset = 0;

  for (const rec of records) {
    const shape = new THREE.Shape();
    rec.points.forEach(([x, y], idx) => {
      if (idx === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });

    const geo = new THREE.ExtrudeGeometry(shape, { depth: rec.height, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);

    const count = geo.attributes.position.count;
    const [r, g, b] = colorForBuilding(rec.distNorm, 0);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    buildingRanges.push({ start: vertexOffset, count, distNorm: rec.distNorm });
    vertexOffset += count;
    geometries.push(geo);
  }

  const merged = mergeGeometries(geometries, false);
  merged.computeVertexNormals();
  for (const g of geometries) g.dispose();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.82,
    metalness: 0.05,
  });
  buildingsMesh = new THREE.Mesh(merged, material);
  buildingsMesh.scale.y = 0.0001;
  scene.add(buildingsMesh);
}

function recolorBuildings(intensity) {
  if (!buildingsMesh) return;
  const colorAttr = buildingsMesh.geometry.attributes.color;
  for (const range of buildingRanges) {
    const [r, g, b] = colorForBuilding(range.distNorm, intensity);
    for (let i = range.start; i < range.start + range.count; i++) {
      colorAttr.setXYZ(i, r, g, b);
    }
  }
  colorAttr.needsUpdate = true;
}

// ---------- scene setup ----------

// ---------- roads (OSM-style ribbons) ----------

const ROAD_Y = 0.08; // just above the ground/basemap, well below buildings and the boundary line
const ROAD_STYLES = {
  motorway: { color: 0xe892a2, width: 5.5 },
  motorway_link: { color: 0xe892a2, width: 3.2 },
  trunk: { color: 0xf9b29c, width: 5 },
  trunk_link: { color: 0xf9b29c, width: 3 },
  primary: { color: 0xfcd6a4, width: 4.2 },
  primary_link: { color: 0xfcd6a4, width: 2.6 },
  secondary: { color: 0xf7fabf, width: 3.4 },
  secondary_link: { color: 0xf7fabf, width: 2.2 },
  tertiary: { color: 0xffffff, width: 2.8 },
  tertiary_link: { color: 0xffffff, width: 2 },
  unclassified: { color: 0xf3f3ee, width: 2.2 },
  residential: { color: 0xffffff, width: 2.2 },
  living_street: { color: 0xecebe5, width: 1.8 },
  service: { color: 0xe4e4e0, width: 1.3 },
  pedestrian: { color: 0xdddde4, width: 1.5 },
  footway: { color: 0xd68a82, width: 1 },
  path: { color: 0xd9c19d, width: 1 },
  construction: { color: 0xcccccc, width: 1.3 },
  default: { color: 0xd8d8d4, width: 1.4 },
};

const CAR_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service',
]);

function processRoads(rawGeojson) {
  const positions = [];
  const colors = [];
  const carRoads = []; // drivable roads, kept as local point paths for the car simulation
  const src = rawGeojson.features || [];
  const roadColor = new THREE.Color();

  for (const feature of src) {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lon0, lat0] = coords[0];
    if (!boundaryContains(boundaryGeometry, lon0, lat0)) continue;

    const highway = feature.properties?.highway;
    const style = ROAD_STYLES[highway] || ROAD_STYLES.default;
    const hw = style.width / 2;
    roadColor.setHex(style.color);
    const r = roadColor.r, g = roadColor.g, b = roadColor.b;

    const local = coords.map(([lon, lat]) => toLocal(lon, lat));
    for (let i = 0; i < local.length - 1; i++) {
      const [x0, z0] = local[i];
      const [x1, z1] = local[i + 1];
      let dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      dx /= len; dz /= len;
      const px = -dz * hw, pz = dx * hw;

      const ax = x0 + px, az = z0 + pz;
      const bx = x0 - px, bz = z0 - pz;
      positions.push(
        ax, ROAD_Y, az, bx, ROAD_Y, bz, x1 - px, ROAD_Y, z1 - pz,
        ax, ROAD_Y, az, x1 - px, ROAD_Y, z1 - pz, x1 + px, ROAD_Y, z1 + pz,
      );
      for (let k = 0; k < 6; k++) colors.push(r, g, b);
    }

    if (CAR_HIGHWAYS.has(highway) && local.length >= 2) {
      let total = 0;
      const cum = [0];
      for (let i = 0; i < local.length - 1; i++) {
        const [x0, z0] = local[i], [x1, z1] = local[i + 1];
        total += Math.hypot(x1 - x0, z1 - z0);
        cum.push(total);
      }
      if (total > 10) carRoads.push({ points: local, cum, total, highway });
    }
  }

  return { positions: new Float32Array(positions), colors: new Float32Array(colors), carRoads };
}

function buildRoadsMesh(roadData) {
  if (!roadData || !roadData.positions.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(roadData.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(roadData.colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geo, material));
}

// ---------- moving traffic ----------

const CAR_COUNT = 2200;
const CAR_SCALE = 3.2; // real car dims are ~4m, invisible from the default ~500m city view — exaggerate for visibility
const CAR_COLORS = [0xffffff, 0x161616, 0xb4b4b4, 0xb0281f, 0x274e8c, 0xd9b23c, 0x5c5c5c];

const BUS_COUNT = 110;
const BUS_LEN = 15, BUS_HEI = 8.5, BUS_WID = 6.5; // deliberately bigger than a scaled car for a clear silhouette
const BUS_COLORS = [0xffffff, 0xffcc33, 0x2f7dd1, 0xff8c42, 0xc7c7c7];
const BUS_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
]);

let carSystem = null;
let busSystem = null;
const _vehicleDummy = new THREE.Object3D();
const _vehicleDir = new THREE.Vector3();

function pointAtDistance(road, dist) {
  const n = road.points.length;
  if (dist <= 0) return { x: road.points[0][0], z: road.points[0][1] };
  if (dist >= road.total) return { x: road.points[n - 1][0], z: road.points[n - 1][1] };
  let seg = 0;
  for (let i = 1; i < road.cum.length; i++) {
    if (road.cum[i] >= dist) { seg = i - 1; break; }
  }
  const segStart = road.cum[seg];
  const segLen = road.cum[seg + 1] - segStart;
  const t = segLen > 0 ? (dist - segStart) / segLen : 0;
  const [x0, z0] = road.points[seg];
  const [x1, z1] = road.points[seg + 1];
  return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t };
}

function buildVehicleSystem({ roads, count, colors, speedRange, yOffset, buildGeometry }) {
  const roadsRef = (roads || []).filter((r) => r.total > 10);
  if (!roadsRef.length) return null;

  const geo = buildGeometry();
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.3,
    metalness: 0.3,
    emissive: 0x0a0a0a,
    emissiveIntensity: 0.6,
    vertexColors: true, // lets baked per-part tints (glass, tires) combine with the per-instance paint color
  });
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const tmpColor = new THREE.Color();
  const state = [];
  for (let i = 0; i < count; i++) {
    const roadIdx = Math.floor(Math.random() * roadsRef.length);
    const dir = Math.random() < 0.5 ? 1 : -1;
    state.push({
      roadIdx,
      dist: Math.random() * roadsRef[roadIdx].total,
      speed: speedRange[0] + Math.random() * (speedRange[1] - speedRange[0]),
      dir,
    });
    tmpColor.setHex(colors[Math.floor(Math.random() * colors.length)]);
    mesh.setColorAt(i, tmpColor);
  }
  scene.add(mesh);
  return { mesh, state, roadsRef, yOffset };
}

function stepVehicleSystem(sys) {
  if (!sys) return;
  const { mesh, state, roadsRef, yOffset } = sys;
  for (let i = 0; i < state.length; i++) {
    const c = state[i];
    let road = roadsRef[c.roadIdx];
    c.dist += c.dir * c.speed;
    if (c.dist > road.total || c.dist < 0) {
      c.roadIdx = Math.floor(Math.random() * roadsRef.length);
      road = roadsRef[c.roadIdx];
      c.dir = Math.random() < 0.5 ? 1 : -1;
      c.dist = c.dir > 0 ? 0 : road.total;
    }

    const p = pointAtDistance(road, c.dist);
    const aheadDist = Math.min(road.total, Math.max(0, c.dist + c.dir * 0.6));
    const p2 = pointAtDistance(road, aheadDist);
    _vehicleDir.set(p2.x - p.x, 0, p2.z - p.z);
    if (_vehicleDir.lengthSq() < 1e-6) _vehicleDir.set(1, 0, 0);
    else _vehicleDir.normalize();

    _vehicleDummy.position.set(p.x, ROAD_Y + yOffset, p.z);
    _vehicleDummy.quaternion.setFromUnitVectors(UNIT_X, _vehicleDir);
    _vehicleDummy.updateMatrix();
    mesh.setMatrixAt(i, _vehicleDummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// Bakes a fixed per-vertex tint onto a geometry; combined with the InstancedMesh's
// per-instance paint color (multiplicatively) so glass/tires/bumpers stay dark
// no matter which random body color a given car gets.
function tintGeometry(geo, r, g, b) {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function buildCarGeometry() {
  const parts = [];

  const chassis = new THREE.BoxGeometry(4.3, 0.85, 1.85);
  chassis.translate(0, 0.775, 0); // rests on top of the wheels, whose bottoms sit at y=0
  parts.push(tintGeometry(chassis, 1, 1, 1)); // white so it fully takes on the instance paint color

  const cabin = new THREE.BoxGeometry(2.3, 0.72, 1.55);
  cabin.translate(-0.15, 1.575, 0);
  parts.push(tintGeometry(cabin, 0.08, 0.09, 0.13)); // tinted glass, stays dark regardless of paint color

  const frontBumper = new THREE.BoxGeometry(0.18, 0.4, 1.9);
  frontBumper.translate(2.16, 0.55, 0);
  parts.push(tintGeometry(frontBumper, 0.06, 0.06, 0.07));

  const rearBumper = new THREE.BoxGeometry(0.18, 0.4, 1.9);
  rearBumper.translate(-2.16, 0.55, 0);
  parts.push(tintGeometry(rearBumper, 0.06, 0.06, 0.07));

  for (const wx of [1.45, -1.45]) {
    for (const wz of [0.98, -0.98]) {
      const wheel = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 14);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(wx, 0.42, wz);
      parts.push(tintGeometry(wheel, 0.02, 0.02, 0.02));
    }
  }

  return mergeGeometries(parts, false);
}

function initCars(carRoads) {
  carSystem = buildVehicleSystem({
    roads: carRoads,
    count: CAR_COUNT,
    colors: CAR_COLORS,
    speedRange: [0.16, 0.38],
    yOffset: 0.05,
    buildGeometry: () => {
      const carGeo = buildCarGeometry();
      carGeo.scale(CAR_SCALE, CAR_SCALE, CAR_SCALE);
      return carGeo;
    },
  });
}

function initBuses(carRoads) {
  const busRoads = (carRoads || []).filter((r) => BUS_HIGHWAYS.has(r.highway));
  busSystem = buildVehicleSystem({
    roads: busRoads,
    count: BUS_COUNT,
    colors: BUS_COLORS,
    speedRange: [0.1, 0.2],
    yOffset: 0.05,
    buildGeometry: () => {
      const busGeo = new THREE.BoxGeometry(BUS_LEN, BUS_HEI, BUS_WID);
      busGeo.translate(0, BUS_HEI / 2, 0);
      return busGeo;
    },
  });
}

function stepCars() {
  stepVehicleSystem(carSystem);
}

function stepBuses() {
  stepVehicleSystem(busSystem);
}

// ---------- traffic lights ----------

const TRAFFIC_LIGHT_CYCLE = 14; // seconds: 6 green, 2 yellow, 6 red
const TRAFFIC_LIGHT_COLORS = { green: 0x2ecc71, yellow: 0xf1c40f, red: 0xe74c3c };
const TRAFFIC_LIGHT_POLE_H = 11;
let trafficLightHeads = null;
let trafficLightPositions = [];

function findIntersections(roads, minDegree, cap) {
  const counts = new Map();
  const reps = new Map();
  const keyOf = (x, z) => `${Math.round(x / 2)},${Math.round(z / 2)}`;
  for (const road of roads) {
    const first = road.points[0];
    const last = road.points[road.points.length - 1];
    for (const [x, z] of [first, last]) {
      const key = keyOf(x, z);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!reps.has(key)) reps.set(key, [x, z]);
    }
  }
  let pts = [];
  for (const [key, count] of counts) {
    if (count >= minDegree) pts.push(reps.get(key));
  }
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  return pts.slice(0, cap);
}

function initTrafficLights(carRoads) {
  const points = findIntersections(carRoads || [], 3, 150);
  if (!points.length) return;
  trafficLightPositions = points;

  const poleGeo = new THREE.CylinderGeometry(0.35, 0.4, TRAFFIC_LIGHT_POLE_H, 8);
  poleGeo.translate(0, TRAFFIC_LIGHT_POLE_H / 2, 0);
  const poleMesh = new THREE.InstancedMesh(
    poleGeo,
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }),
    points.length,
  );
  points.forEach(([x, z], i) => {
    _vehicleDummy.position.set(x, ROAD_Y, z);
    _vehicleDummy.quaternion.identity();
    _vehicleDummy.updateMatrix();
    poleMesh.setMatrixAt(i, _vehicleDummy.matrix);
  });
  poleMesh.instanceMatrix.needsUpdate = true;
  scene.add(poleMesh);

  const headGeo = new THREE.BoxGeometry(1.3, 2, 1.3);
  headGeo.translate(0, TRAFFIC_LIGHT_POLE_H + 0.6, 0);
  trafficLightHeads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), points.length);
  const headColor = new THREE.Color();
  points.forEach(([x, z], i) => {
    _vehicleDummy.position.set(x, ROAD_Y, z);
    _vehicleDummy.quaternion.identity();
    _vehicleDummy.updateMatrix();
    trafficLightHeads.setMatrixAt(i, _vehicleDummy.matrix);
    headColor.setHex(TRAFFIC_LIGHT_COLORS.red);
    trafficLightHeads.setColorAt(i, headColor);
  });
  trafficLightHeads.instanceMatrix.needsUpdate = true;
  scene.add(trafficLightHeads);
}

function trafficPhaseColor(t) {
  if (t < 6) return TRAFFIC_LIGHT_COLORS.green;
  if (t < 8) return TRAFFIC_LIGHT_COLORS.yellow;
  return TRAFFIC_LIGHT_COLORS.red;
}

const _tlColor = new THREE.Color();
function stepTrafficLights(elapsed) {
  if (!trafficLightHeads) return;
  for (let i = 0; i < trafficLightPositions.length; i++) {
    const phase = (elapsed + i * 3.5) % TRAFFIC_LIGHT_CYCLE;
    _tlColor.setHex(trafficPhaseColor(phase));
    trafficLightHeads.setColorAt(i, _tlColor);
  }
  trafficLightHeads.instanceColor.needsUpdate = true;
}

// ---------- pollution haze at major intersections ----------
// Ground-hugging radial gradient "stain" spreading from each busy intersection
// (like a real-world air-quality heat map: hot core fading outward), plus a
// small pulsing glow core above it so it still reads from a distance.

const HOTSPOT_BASE_RADIUS = 30;
let pollutionHotspots = null; // { groundMesh, coreMesh, points, distNorms }
const _hotspotDummy = new THREE.Object3D();

function nearestStationDistLocal(x, z, stationsLocal) {
  let best = Infinity;
  for (const [sx, sz] of stationsLocal || []) {
    const d = Math.hypot(x - sx, z - sz);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : MAX_STATION_DIST;
}

// A flat disc whose per-vertex alpha fades from opaque at the center to
// transparent at the rim; combined with an instance color this becomes a
// radiating gradient patch, like the pollution spreading out from a crossroads.
function buildGradientDiscGeometry(radius, segments) {
  const geo = new THREE.CircleGeometry(radius, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const rgba = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.hypot(pos.getX(i), pos.getZ(i)) / radius);
    const alpha = Math.pow(1 - t, 1.7) * 0.85;
    rgba[i * 4] = 1; rgba[i * 4 + 1] = 1; rgba[i * 4 + 2] = 1; rgba[i * 4 + 3] = alpha;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  return geo;
}

function initPollutionHotspots(carRoads, stationsLocal) {
  const majorRoads = (carRoads || []).filter((r) => BUS_HIGHWAYS.has(r.highway));
  const points = findIntersections(majorRoads, 3, 40);
  if (!points.length) return;

  const distNorms = points.map(([x, z]) =>
    Math.min(1, nearestStationDistLocal(x, z, stationsLocal) / MAX_STATION_DIST),
  );

  const groundGeo = buildGradientDiscGeometry(HOTSPOT_BASE_RADIUS, 40);
  const groundMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const groundMesh = new THREE.InstancedMesh(groundGeo, groundMaterial, points.length);

  const coreGeo = new THREE.SphereGeometry(5, 14, 10);
  coreGeo.scale(1, 0.5, 1);
  coreGeo.translate(0, 12, 0);
  const coreMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const coreMesh = new THREE.InstancedMesh(coreGeo, coreMaterial, points.length);

  const color = new THREE.Color(0.18, 0.8, 0.44);
  points.forEach(([x, z], i) => {
    _hotspotDummy.position.set(x, ROAD_Y + 0.03, z);
    _hotspotDummy.scale.setScalar(1);
    _hotspotDummy.updateMatrix();
    groundMesh.setMatrixAt(i, _hotspotDummy.matrix);
    groundMesh.setColorAt(i, color);

    _hotspotDummy.position.set(x, ROAD_Y, z);
    _hotspotDummy.updateMatrix();
    coreMesh.setMatrixAt(i, _hotspotDummy.matrix);
    coreMesh.setColorAt(i, color);
  });
  groundMesh.instanceMatrix.needsUpdate = true;
  coreMesh.instanceMatrix.needsUpdate = true;
  scene.add(groundMesh);
  scene.add(coreMesh);

  pollutionHotspots = { groundMesh, coreMesh, points, distNorms };
}

function recolorPollutionHotspots(intensity) {
  if (!pollutionHotspots) return;
  const { groundMesh, points, distNorms } = pollutionHotspots;
  const color = new THREE.Color();
  for (let i = 0; i < distNorms.length; i++) {
    const [r, g, b] = colorForBuilding(distNorms[i], intensity);
    color.setRGB(r, g, b);
    groundMesh.setColorAt(i, color);
    pollutionHotspots.coreMesh.setColorAt(i, color);

    // worse pollution -> the ground stain spreads further, like real gridlock haze
    const score = Math.max(0, Math.min(1, (1 - distNorms[i]) * intensity));
    const [x, z] = points[i];
    _hotspotDummy.position.set(x, ROAD_Y + 0.03, z);
    _hotspotDummy.scale.setScalar(0.55 + score * 1.05);
    _hotspotDummy.updateMatrix();
    groundMesh.setMatrixAt(i, _hotspotDummy.matrix);
  }
  groundMesh.instanceMatrix.needsUpdate = true;
  groundMesh.instanceColor.needsUpdate = true;
  pollutionHotspots.coreMesh.instanceColor.needsUpdate = true;
}

function stepPollutionHotspots(elapsed) {
  if (!pollutionHotspots) return;
  const { coreMesh, points } = pollutionHotspots;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    const pulse = 1 + Math.sin(elapsed * 0.8 + i * 1.7) * 0.14;
    _hotspotDummy.position.set(x, ROAD_Y, z);
    _hotspotDummy.scale.setScalar(pulse);
    _hotspotDummy.updateMatrix();
    coreMesh.setMatrixAt(i, _hotspotDummy.matrix);
  }
  coreMesh.instanceMatrix.needsUpdate = true;
}

function buildBoundaryLines() {
  if (!boundaryGeometry) return;
  const rings = allOuterRings(boundaryGeometry);
  const material = new THREE.LineBasicMaterial({ color: 0x57a7ff, transparent: true, opacity: 0.9 });
  for (const ring of rings) {
    const pts = ring.map(([lon, lat]) => {
      const [x, z] = toLocal(lon, lat);
      return new THREE.Vector3(x, 1.2, z);
    });
    if (pts.length && !pts[0].equals(pts[pts.length - 1])) pts.push(pts[0].clone());
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  }
}

function buildGround(bbox) {
  const w = (bbox.maxLon - bbox.minLon) * 111320 * Math.cos((centerLonLat[1] * Math.PI) / 180) + 1200;
  const h = (bbox.maxLat - bbox.minLat) * 110540 + 1200;
  const geo = new THREE.PlaneGeometry(Math.max(w, 800), Math.max(h, 800), 24, 24);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a1730, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(geo, mat);
  ground.position.y = -0.6;
  scene.add(ground);

}

// ---------- OSM raster basemap (slippy-tile math) ----------

function lonLatToTileFrac(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

function tileToLonLat(tx, ty, zoom) {
  const n = 2 ** zoom;
  const lon = (tx / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n)));
  return [lon, (latRad * 180) / Math.PI];
}

function loadTileImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Composites every tile onto one shared canvas -> one texture -> one ground
// plane, instead of many separate tile meshes. This avoids seams/gaps between
// tiles and means there's a single, easy-to-verify piece of geometry to place.
// Loads in the background (never awaited) so a slow/unreachable tile server
// can't block buildings or wind from showing up.
function buildBasemap(bbox, onProgress) {
  const [x1f, y1f] = lonLatToTileFrac(bbox.minLon, bbox.maxLat, BASEMAP_ZOOM);
  const [x2f, y2f] = lonLatToTileFrac(bbox.maxLon, bbox.minLat, BASEMAP_ZOOM);
  const xStart = Math.floor(x1f), xEnd = Math.floor(x2f);
  const yStart = Math.floor(y1f), yEnd = Math.floor(y2f);
  const cols = xEnd - xStart + 1;
  const rows = yEnd - yStart + 1;

  const canvas = document.createElement('canvas');
  canvas.width = cols * 256;
  canvas.height = rows * 256;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const [lonA, latA] = tileToLonLat(xStart, yStart, BASEMAP_ZOOM);
  const [lonB, latB] = tileToLonLat(xEnd + 1, yEnd + 1, BASEMAP_ZOOM);
  const [xA, zA] = toLocal(lonA, latA);
  const [xB, zB] = toLocal(lonB, latB);
  const width = Math.abs(xB - xA);
  const height = Math.abs(zB - zA);
  const cx = (xA + xB) / 2;
  const cz = (zA + zB) / 2;

  const geo = new THREE.PlaneGeometry(width, height);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, -0.3, cz);
  scene.add(mesh);

  const tiles = [];
  for (let tx = xStart; tx <= xEnd; tx++) {
    for (let ty = yStart; ty <= yEnd; ty++) tiles.push([tx, ty]);
  }

  const CONCURRENCY = 8;
  let nextIndex = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    while (nextIndex < tiles.length) {
      const [tx, ty] = tiles[nextIndex++];
      const img = await loadTileImage(BASEMAP_TILE_URL(BASEMAP_ZOOM, tx, ty));
      done++;
      if (img) {
        ctx.drawImage(img, (tx - xStart) * 256, (ty - yStart) * 256, 256, 256);
        texture.needsUpdate = true;
      } else {
        failed++;
      }
      if (onProgress) onProgress(done, tiles.length, failed);
    }
  }

  Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
    // once every tile is in, switch on mipmaps + anisotropic filtering for a
    // sharp, alias-free look at the oblique angles the 3D camera views it from
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : 1;
    texture.needsUpdate = true;
  });
}

// ---------- building height-field (cheap collision grid) ----------

const HEIGHT_FIELD_CELL = 6; // meters
let heightField = null;
let heightFieldMeta = null;

function buildHeightField(records) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const rec of records) {
    for (const [x, y] of rec.points) {
      const z = -y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return;

  const cols = Math.max(1, Math.ceil((maxX - minX) / HEIGHT_FIELD_CELL) + 1);
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / HEIGHT_FIELD_CELL) + 1);
  heightField = new Float32Array(cols * rows);
  heightFieldMeta = { minX, minZ, cols, rows };

  for (const rec of records) {
    let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
    for (const [x, y] of rec.points) {
      const z = -y;
      if (x < bMinX) bMinX = x;
      if (x > bMaxX) bMaxX = x;
      if (z < bMinZ) bMinZ = z;
      if (z > bMaxZ) bMaxZ = z;
    }
    const c0 = Math.floor((bMinX - minX) / HEIGHT_FIELD_CELL);
    const c1 = Math.floor((bMaxX - minX) / HEIGHT_FIELD_CELL);
    const r0 = Math.floor((bMinZ - minZ) / HEIGHT_FIELD_CELL);
    const r1 = Math.floor((bMaxZ - minZ) / HEIGHT_FIELD_CELL);
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= rows) continue;
      for (let c = c0; c <= c1; c++) {
        if (c < 0 || c >= cols) continue;
        const idx = r * cols + c;
        if (rec.height > heightField[idx]) heightField[idx] = rec.height;
      }
    }
  }
}

function buildingHeightAt(x, z) {
  if (!heightField) return 0;
  const c = Math.floor((x - heightFieldMeta.minX) / HEIGHT_FIELD_CELL);
  const r = Math.floor((z - heightFieldMeta.minZ) / HEIGHT_FIELD_CELL);
  if (c < 0 || c >= heightFieldMeta.cols || r < 0 || r >= heightFieldMeta.rows) return 0;
  return heightField[r * heightFieldMeta.cols + c];
}

// ---------- flow-trail wind particles (curve around buildings, like a real airflow) ----------

const TRAIL_LEN = 6; // points per particle's fading tail
const SEGMENTS_PER_PARTICLE = TRAIL_LEN - 1;
const PROBE_DIST = 16; // meters — how far ahead each particle "feels" for an obstacle
let flowTrails = null; // Float32Array: [particle][trailPoint][xyz]
let flowVel = null; // Float32Array: [particle][xz] current (normalized-ish) direction
let currentWindColor = new THREE.Color();
const _flowDummy = new THREE.Object3D();
const _flowDir = new THREE.Vector3();
const _flowColor = new THREE.Color();
const UNIT_X = new THREE.Vector3(1, 0, 0);

function resetTrail(i, x, y, z) {
  const base = i * TRAIL_LEN * 3;
  for (let j = 0; j < TRAIL_LEN; j++) {
    flowTrails[base + j * 3] = x;
    flowTrails[base + j * 3 + 1] = y;
    flowTrails[base + j * 3 + 2] = z;
  }
}

function respawnParticle(i) {
  const x = windBounds.minX + Math.random() * (windBounds.maxX - windBounds.minX);
  const z = windBounds.minZ + Math.random() * (windBounds.maxZ - windBounds.minZ);
  const y = 12 + Math.random() * 110;
  resetTrail(i, x, y, z);
  flowVel[i * 2] = windVector.x;
  flowVel[i * 2 + 1] = windVector.z;
}

function initWindParticles() {
  flowTrails = new Float32Array(PARTICLE_COUNT * TRAIL_LEN * 3);
  flowVel = new Float32Array(PARTICLE_COUNT * 2);
  windPhases = new Float32Array(PARTICLE_COUNT);
  currentWindColor.setHSL(windHue / 360, 0.95, 0.7);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    respawnParticle(i);
    windPhases[i] = Math.random() * Math.PI * 2;
  }

  // a thin "rod" stretching from the origin along +X, so scale.x doubles as segment length;
  // one instance per trail segment, so the curving path stays volumetric (visible at any zoom)
  const geo = new THREE.BoxGeometry(1, 1.9, 1.9);
  geo.translate(0.5, 0, 0);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  windPoints = new THREE.InstancedMesh(geo, material, PARTICLE_COUNT * SEGMENTS_PER_PARTICLE);
  windPoints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(windPoints);
}

function updateWindStreakColor() {
  currentWindColor.setHSL(windHue / 360, 0.95, 0.7);
  if (windHeroMaterial) windHeroMaterial.color.copy(currentWindColor);
}

function updateWindOrientation() {
  const dir = new THREE.Vector3(windVector.x, 0, windVector.z);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  if (windHero) windHero.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

// A large, unmissable horizontal arrow floating above the city, pointing the
// way the wind blows — a guaranteed-visible signal alongside the streaks.
let windHero = null;
let windHeroMaterial = null;
const WIND_HERO_HEIGHT = 195;

function buildWindHero() {
  windHeroMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setHSL(windHue / 360, 0.95, 0.7),
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const group = new THREE.Group();
  const shaftGeo = new THREE.CylinderGeometry(2.4, 2.4, 46, 18);
  shaftGeo.translate(0, 23, 0);
  group.add(new THREE.Mesh(shaftGeo, windHeroMaterial));

  const headGeo = new THREE.ConeGeometry(6.5, 20, 22);
  headGeo.translate(0, 56, 0);
  group.add(new THREE.Mesh(headGeo, windHeroMaterial));

  group.position.set(0, WIND_HERO_HEIGHT, 0);
  scene.add(group);
  windHero = group;
  updateWindOrientation();
}

function stepWindHero(elapsed) {
  if (!windHero || !windHeroMaterial) return;
  windHeroMaterial.opacity = 0.75 + 0.25 * Math.sin(elapsed * 1.8);
  windHero.position.y = WIND_HERO_HEIGHT + Math.sin(elapsed * 0.6) * 8;
}

function rotateY(x, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c - z * s, x * s + z * c];
}

function stepWindParticles(elapsed) {
  if (!windPoints) return;
  const baseSpeed = Math.min(2.6, 0.6 + windVector.speed * 0.1);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const base = i * TRAIL_LEN * 3;
    const headIdx = base + (TRAIL_LEN - 1) * 3;
    const hx = flowTrails[headIdx], hy = flowTrails[headIdx + 1], hz = flowTrails[headIdx + 2];

    let dx = flowVel[i * 2], dz = flowVel[i * 2 + 1];
    const mag = Math.hypot(dx, dz) || 1;
    dx /= mag; dz /= mag;

    // probe ahead; if blocked, steer toward whichever side is clearer (flow around obstacles)
    const aheadX = hx + dx * PROBE_DIST, aheadZ = hz + dz * PROBE_DIST;
    if (buildingHeightAt(aheadX, aheadZ) > hy) {
      const [lx, lz] = rotateY(dx, dz, Math.PI / 3);
      const [rx, rz] = rotateY(dx, dz, -Math.PI / 3);
      const leftH = buildingHeightAt(hx + lx * PROBE_DIST, hz + lz * PROBE_DIST);
      const rightH = buildingHeightAt(hx + rx * PROBE_DIST, hz + rz * PROBE_DIST);
      const [steerX, steerZ] = leftH <= rightH ? [lx, lz] : [rx, rz];
      dx += (steerX - dx) * 0.35;
      dz += (steerZ - dz) * 0.35;
    } else {
      // gently relax back toward the prevailing wind once clear of an obstacle
      dx += (windVector.x - dx) * 0.04;
      dz += (windVector.z - dz) * 0.04;
    }
    const newMag = Math.hypot(dx, dz) || 1;
    dx /= newMag; dz /= newMag;
    flowVel[i * 2] = dx;
    flowVel[i * 2 + 1] = dz;

    let nx = hx + dx * baseSpeed;
    let ny = hy + Math.sin(elapsed * 0.6 + windPhases[i]) * 0.05;
    let nz = hz + dz * baseSpeed;

    const outOfBounds = nx < windBounds.minX || nx > windBounds.maxX || nz < windBounds.minZ || nz > windBounds.maxZ;
    const insideBuilding = buildingHeightAt(nx, nz) > ny;

    if (outOfBounds || insideBuilding) {
      respawnParticle(i);
    } else {
      // shift the trail down one slot and append the new head
      for (let j = 0; j < TRAIL_LEN - 1; j++) {
        flowTrails[base + j * 3] = flowTrails[base + (j + 1) * 3];
        flowTrails[base + j * 3 + 1] = flowTrails[base + (j + 1) * 3 + 1];
        flowTrails[base + j * 3 + 2] = flowTrails[base + (j + 1) * 3 + 2];
      }
      flowTrails[headIdx] = nx;
      flowTrails[headIdx + 1] = ny;
      flowTrails[headIdx + 2] = nz;
    }

    for (let s = 0; s < SEGMENTS_PER_PARTICLE; s++) {
      const p0 = base + s * 3;
      const p1 = base + (s + 1) * 3;
      const x0 = flowTrails[p0], y0 = flowTrails[p0 + 1], z0 = flowTrails[p0 + 2];
      const x1 = flowTrails[p1], y1 = flowTrails[p1 + 1], z1 = flowTrails[p1 + 2];

      _flowDir.set(x1 - x0, y1 - y0, z1 - z0);
      const segLen = _flowDir.length();
      if (segLen > 1e-4) _flowDir.divideScalar(segLen);
      else _flowDir.copy(UNIT_X);

      _flowDummy.position.set(x0, y0, z0);
      _flowDummy.quaternion.setFromUnitVectors(UNIT_X, _flowDir);
      _flowDummy.scale.set(segLen, 1, 1);
      _flowDummy.updateMatrix();

      const instIdx = i * SEGMENTS_PER_PARTICLE + s;
      windPoints.setMatrixAt(instIdx, _flowDummy.matrix);
      const brightness = 0.15 + 0.85 * ((s + 1) / SEGMENTS_PER_PARTICLE);
      _flowColor.copy(currentWindColor).multiplyScalar(brightness);
      windPoints.setColorAt(instIdx, _flowColor);
    }
  }
  windPoints.instanceMatrix.needsUpdate = true;
  if (windPoints.instanceColor) windPoints.instanceColor.needsUpdate = true;
}

// ---------- color / wind data ----------

function computeIntensity(year, pollutant, measure) {
  if (!map3dDataStore || !map3dDataStore.years || !map3dDataStore.years[year]) return 0;
  const months = map3dDataStore.months || [];
  let max = 0;
  for (const y of Object.keys(map3dDataStore.years)) {
    for (const m of months) {
      const v = map3dDataStore.years[y][m]?.[pollutant]?.[measure];
      if (typeof v === 'number' && v > max) max = v;
    }
  }
  if (max <= 0) return 0;
  const values = months.map((m) => map3dDataStore.years[year][m]?.[pollutant]?.[measure]).filter((v) => typeof v === 'number');
  if (!values.length) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.min(1, avg / max);
}

const WIND_DIRECTION_ANGLES = {
  Shimol: 0, 'Shimoliy sharq': 45, Sharq: 90, 'Janubiy sharq': 135,
  Janub: 180, 'Janubiy G‘arb': 225, 'G‘arb': 270, 'Shimoliy G‘arb': 315,
};

function computeWindVector(year) {
  const wind = map3dDataStore?.wind;
  if (!wind || !wind.years || !wind.years[year]) return { x: 0, z: -1, speed: 0 };
  let vx = 0, vz = 0, totalSpeed = 0, count = 0;
  for (const [direction, angle] of Object.entries(WIND_DIRECTION_ANGLES)) {
    const values = map3dDataStore.months.map((m) => wind.years[year][m]?.[direction]).filter((v) => typeof v === 'number');
    if (!values.length) continue;
    const avgSpeed = values.reduce((a, b) => a + b, 0) / values.length;
    const rad = (angle * Math.PI) / 180;
    vx += Math.sin(rad) * avgSpeed;
    vz += -Math.cos(rad) * avgSpeed;
    totalSpeed += avgSpeed;
    count++;
  }
  const avgSpeed = count ? totalSpeed / count : 0;
  const mag = Math.sqrt(vx * vx + vz * vz);
  if (mag < 1e-6) return { x: 0, z: -1, speed: avgSpeed };
  return { x: vx / mag, z: vz / mag, speed: avgSpeed };
}

let manualWindActive = false;

function pollSelectors() {
  const yearEl = document.getElementById('yearSelect');
  const pollutantEl = document.getElementById('pollutantSelect');
  const measureEl = document.getElementById('measureSelect');
  if (!yearEl || !pollutantEl || !measureEl) return;
  const year = yearEl.value, pollutant = pollutantEl.value, measure = measureEl.value;
  if (!year || !pollutant || !measure) return;

  const key = `${year}|${pollutant}|${measure}`;
  if (key !== lastSelectorKey) {
    lastSelectorKey = key;
    currentIntensity = computeIntensity(year, pollutant, measure);
    recolorBuildings(currentIntensity);
    recolorPollutionHotspots(currentIntensity);
    windHue = POLLUTANT_HUES[pollutant] ?? 210;
    if (!manualWindActive) {
      windVector = computeWindVector(year);
      updateWindOrientation();
    }
    updateWindStreakColor();
  }
}

// Lets the user type in a wind speed/direction by hand and see the 3D flow
// react immediately, instead of always being driven by the historical data.
function applyManualWind(speedMs, directionDeg) {
  manualWindActive = true;
  const rad = (directionDeg * Math.PI) / 180;
  windVector = { x: Math.sin(rad), z: -Math.cos(rad), speed: Math.max(0, speedMs) };
  updateWindOrientation();
  bouncePulse();
}

// ---------- animation ----------

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateRise() {
  if (!buildingsMesh) return;
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / RISE_DURATION);
    buildingsMesh.scale.y = Math.max(0.0001, easeOutCubic(t));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function bouncePulse() {
  if (!buildingsMesh) return;
  const start = performance.now();
  const duration = 850;
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    buildingsMesh.scale.y = 1 + 0.12 * Math.sin(t * Math.PI);
    if (t < 1) requestAnimationFrame(frame);
    else buildingsMesh.scale.y = 1;
  }
  requestAnimationFrame(frame);
}

function buildTourStops() {
  const stops = [{ pos: [10, 320, 420], target: [0, 0, 0] }];
  for (const [x, z] of stationCoordsLocal) {
    stops.push({ pos: [x + 130, 95 + Math.random() * 45, z + 130], target: [x, 18, z] });
  }
  return stops;
}

function flyToStop(stop) {
  isFlying = true;
  controls.autoRotate = false;
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endPos = new THREE.Vector3(...stop.pos);
  const endTarget = new THREE.Vector3(...stop.target);
  const start = performance.now();
  const duration = 3200;
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = easeOutCubic(t);
    camera.position.lerpVectors(startPos, endPos, eased);
    controls.target.lerpVectors(startTarget, endTarget, eased);
    controls.update();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      isFlying = false;
      controls.autoRotate = rotating;
      bouncePulse();
    }
  }
  requestAnimationFrame(frame);
}

function advanceTour() {
  if (!tourStops.length) return;
  tourIndex = (tourIndex + 1) % tourStops.length;
  flyToStop(tourStops[tourIndex]);
}

function startTour() {
  if (!tourStops.length || tourTimer) return;
  advanceTour();
  tourTimer = setInterval(advanceTour, 9000);
}

function stopTour() {
  if (tourTimer) {
    clearInterval(tourTimer);
    tourTimer = null;
  }
}

// ---------- UI ----------

function setLoading(visible, message) {
  const el = document.getElementById('map3dLoading');
  if (!el) return;
  if (message) el.querySelector('p').textContent = message;
  el.classList.toggle('hidden', !visible);
}

function setBackendBadge(isWebGPU) {
  const badge = document.getElementById('map3dBackendBadge');
  if (!badge) return;
  badge.textContent = isWebGPU ? 'WebGPU' : 'WebGL2 (zaxira)';
  badge.classList.toggle('is-webgpu', isWebGPU);
}

function initControls() {
  document.getElementById('replayAnimBtn')?.addEventListener('click', animateRise);
  document.getElementById('toggleRotateBtn')?.addEventListener('click', (e) => {
    rotating = !rotating;
    e.target.textContent = rotating ? "⏸ Aylanishni to'xtatish" : "▶ Aylanishni boshlash";
    controls.autoRotate = rotating && !isFlying;
    if (rotating) startTour(); else stopTour();
  });

  document.getElementById('applyManualWindBtn')?.addEventListener('click', () => {
    const speed = parseFloat(document.getElementById('windSpeedInput')?.value) || 0;
    const dirDeg = parseFloat(document.getElementById('windDirInput')?.value) || 0;
    const autoToggle = document.getElementById('windAutoToggle');
    if (autoToggle) autoToggle.checked = false;
    applyManualWind(speed, dirDeg);
  });

  document.getElementById('windAutoToggle')?.addEventListener('change', (e) => {
    manualWindActive = !e.target.checked;
    if (!manualWindActive) {
      lastSelectorKey = ''; // force pollSelectors to recompute wind from data right away
    }
  });
}

function onResize() {
  if (!renderer || !container) return;
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- bootstrap ----------

async function init() {
  initControls();
  container = document.getElementById('map3d');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050b18);
  scene.fog = new THREE.Fog(0x050b18, 500, 1700);

  camera = new THREE.PerspectiveCamera(55, container.clientWidth / Math.max(1, container.clientHeight), 1, 5000);
  camera.position.set(10, 320, 420);

  renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  setBackendBadge(renderer.backend.isWebGPUBackend === true);

  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 20, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.7;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 40;
  controls.maxDistance = 1400;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xbfdcff, 0x10243f, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(320, 520, 200);
  scene.add(sun);

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(container);
  } else {
    window.addEventListener('resize', onResize);
  }


  try {
    const [buildingsResp, dataResp, stationsResp, boundaryResp, roadsResp] = await Promise.all([
      fetch('buildings.geojson'),
      fetch('data/samarqand_data.json'),
      fetch('data/stations.geojson'),
      fetch('samarqand.json'),
      fetch('roads.geojson'),
    ]);
    if (!buildingsResp.ok || !dataResp.ok || !stationsResp.ok || !boundaryResp.ok) {
      throw new Error("3D bino ma'lumotlarini yuklab bo'lmadi.");
    }

    setLoading(true, "Ma'lumotlar tahlil qilinmoqda...");
    const [buildingsRaw, dataStore, stationsGeojson, boundaryGeojson, roadsRaw] = await Promise.all([
      buildingsResp.json(), dataResp.json(), stationsResp.json(), boundaryResp.json(),
      roadsResp.ok ? roadsResp.json() : Promise.resolve(null),
    ]);

    map3dDataStore = dataStore;
    boundaryGeometry = boundaryGeojson.features?.[0]?.geometry || null;

    const stationLonLat = (stationsGeojson.features || []).map((f) => f.geometry?.coordinates).filter(Boolean);

    if (boundaryGeometry) {
      const bbox = geometryBounds(boundaryGeometry);
      centerLonLat = [(bbox.minLon + bbox.maxLon) / 2, (bbox.minLat + bbox.maxLat) / 2];

      stationCoordsLocal = stationLonLat.map(([lon, lat]) => toLocal(lon, lat));

      buildGround(bbox);
      buildBoundaryLines();
      // loads tiles in the background; never blocks the scene
      buildBasemap(bbox, (done, total, failed) => {
        const badge = document.getElementById('map3dBasemapBadge');
        if (!badge) return;
        if (done < total) {
          badge.textContent = `Xarita: ${done}/${total}`;
        } else if (failed === total) {
          badge.textContent = 'Xarita: yuklanmadi (internet/server tekshiring)';
          badge.classList.add('is-error');
        } else {
          badge.textContent = `Xarita: ${total - failed}/${total} kafelcha`;
          badge.classList.add('is-webgpu');
        }
      });

      const cornerA = toLocal(bbox.minLon, bbox.minLat);
      const cornerB = toLocal(bbox.maxLon, bbox.maxLat);
      windBounds = {
        minX: Math.min(cornerA[0], cornerB[0]) - WIND_BOUNDS_MARGIN,
        maxX: Math.max(cornerA[0], cornerB[0]) + WIND_BOUNDS_MARGIN,
        minZ: Math.min(cornerA[1], cornerB[1]) - WIND_BOUNDS_MARGIN,
        maxZ: Math.max(cornerA[1], cornerB[1]) + WIND_BOUNDS_MARGIN,
      };

      setLoading(true, 'Binolar qurilmoqda...');
      const records = processBuildings(buildingsRaw, stationLonLat);
      buildBuildingsMesh(records);
      buildHeightField(records);

      if (roadsRaw) {
        setLoading(true, "Yo'llar chizilmoqda...");
        const roadData = processRoads(roadsRaw);
        buildRoadsMesh(roadData);
        initCars(roadData.carRoads);
        initBuses(roadData.carRoads);
        initTrafficLights(roadData.carRoads);
        initPollutionHotspots(roadData.carRoads, stationCoordsLocal);
        recolorPollutionHotspots(currentIntensity);
      }

      tourStops = buildTourStops();
    }

    initWindParticles();
    buildWindHero();
    pollSelectors();
    setInterval(pollSelectors, 400);

    setLoading(false);
    animateRise();
    setTimeout(startTour, 2600);
  } catch (err) {
    setLoading(true, err.message || '3D xaritani yuklashda xatolik yuz berdi.');
  }

  renderer.setAnimationLoop(() => {
    const elapsed = (performance.now() - sceneStartTime) / 1000;
    if (!isFlying) controls.update();
    stepWindParticles(elapsed);
    stepWindHero(elapsed);
    stepCars();
    stepBuses();
    stepTrafficLights(elapsed);
    stepPollutionHotspots(elapsed);
    renderer.render(scene, camera);
  });
}

window.addEventListener('DOMContentLoaded', init);
