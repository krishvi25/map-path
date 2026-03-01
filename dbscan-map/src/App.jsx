import { useEffect, useState, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polygon,
  Polyline,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import Papa from "papaparse";
import * as turf from "@turf/turf";
import { dbscan } from "./dbscan";
import "leaflet/dist/leaflet.css";
import "./leafletFix";

/* ---------------- ICON ---------------- */

function pinIcon(color) {
  return L.divIcon({
    html: `<div style="
      background:${color};
      width:14px;
      height:14px;
      border-radius:50% 50% 50% 0;
      transform: rotate(-45deg);
      border:2px solid white;
    "></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 14],
  });
}

/* ---------------- MAP CLICK ---------------- */

function MapClickHandler({ onSelect, enabled }) {
  useMapEvents({
    click(e) {
      if (enabled) onSelect([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

/* ---------------- APP ---------------- */

export default function App() {
  const [points, setPoints] = useState([]);
  const [userLocation, setUserLocation] = useState(null);
  const [destination, setDestination] = useState(null);
  const [routeOptions, setRouteOptions] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [journeyStarted, setJourneyStarted] = useState(false);
  const [zoneAlert, setZoneAlert] = useState(null);
  const [speed, setSpeed] = useState(0);
const [searchText, setSearchText] = useState("");
  const voiceIntervalRef = useRef(null);
  const activeAlertRef = useRef(null);
  const watchIdRef = useRef(null);
const [suggestions, setSuggestions] = useState([]);
  const eps = 80 / 111000;
  const minPts = 3;
const debounceRef = useRef(null);
const [searchLoading, setSearchLoading] = useState(false);
const [showPanel, setShowPanel] = useState(true);
  /* ---------------- HELPERS ---------------- */

  function clusterColor(size) {
    if (size >= 6) return "red";
    if (size >= 4) return "orange";
    return "green";
  }

  function getSpeedLimit(color) {
    if (color === "red") return 30;
    if (color === "orange") return 45;
    return 60;
  }
/*--------s4earch-----*/
async function searchPlace(query) {
  if (!query || query.length < 3) {
    setSuggestions([]);
    return;
  }

  try {
    setSearchLoading(true);

    const res = await fetch(
      `http://localhost:5000/search?q=${encodeURIComponent(query)}`
    );

    const data = await res.json();
    setSuggestions(data);

  } catch (err) {
    console.log("Search error:", err);
  } finally {
    setSearchLoading(false);
  }
}
  /* ---------------- VOICE ---------------- */

  function speak(text, repeat = false) {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    clearInterval(voiceIntervalRef.current);

    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);

    if (repeat) {
      voiceIntervalRef.current = setInterval(() => {
        const repeatUtterance = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(repeatUtterance);
      }, 5000);
    }
  }

  function stopAlerts() {
    clearInterval(voiceIntervalRef.current);
    window.speechSynthesis.cancel();
    activeAlertRef.current = null;
    setZoneAlert(null);
  }

  /* ---------------- LOAD CSV ---------------- */

  useEffect(() => {
    Papa.parse("/locations.csv", {
      download: true,
      header: true,
      complete: (res) => {
        const clean = res.data
          .map((r) => ({
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lng),
          }))
          .filter((p) => !isNaN(p.lat) && !isNaN(p.lng));

        setPoints(clean);
      },
    });
  }, []);

  const clustered = dbscan(points, eps, minPts);
  const clusters = {};

  clustered.forEach((p) => {
    if (p.cluster !== -1) {
      clusters[p.cluster] ??= [];
      clusters[p.cluster].push(p);
    }
  });

  /* ---------------- LOCATION ---------------- */

  function getMyLocation() {
    navigator.geolocation.getCurrentPosition((pos) => {
      setUserLocation([pos.coords.latitude, pos.coords.longitude]);
    });
  }
useEffect(() => {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setUserLocation([pos.coords.latitude, pos.coords.longitude]);
    },
    (err) => console.log(err),
    { enableHighAccuracy: true }
  );
}, []);
  /* ---------------- ROUTES ---------------- */

  async function showRoutes() {
    if (!userLocation || !destination) return;

    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${userLocation[1]},${userLocation[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson&alternatives=true`
    );

    const data = await res.json();

    const processed = data.routes.map((r, index) => {
      const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const distance = (r.distance / 1000).toFixed(1);
      const duration = Math.round(r.duration / 60);

      return { id: index, coords, distance, duration };
    });

    setRouteOptions(processed);
    setSelectedRoute(processed[0]);
  }
function calculateRouteSeverity(routeCoords) {
  let dangerCount = 0;

  routeCoords.forEach(([lat, lng]) => {
    const point = turf.point([lng, lat]);

    for (const pts of Object.values(clusters)) {
      const hull = turf.convex(
        turf.featureCollection(
          pts.map((p) => turf.point([p.lng, p.lat]))
        )
      );

      if (!hull) continue;

      const buffered = turf.buffer(hull, 0.2, { units: "kilometers" });

      if (turf.booleanPointInPolygon(point, buffered)) {
        dangerCount++;
      }
    }
  });

  if (dangerCount > 20) return "High 🔴";
  if (dangerCount > 8) return "Medium 🟠";
  return "Low 🟢";
}
  /* ---------------- START JOURNEY ---------------- */

  function startJourney() {
    if (!selectedRoute) return;

    setJourneyStarted(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        setUserLocation([lat, lng]);

        const userPoint = turf.point([lng, lat]);
        const speedKmh = pos.coords.speed ? pos.coords.speed * 3.6 : 0;

        setSpeed(speedKmh);

        /* ---------------- ZONE LOGIC ---------------- */

        let inAnyZone = false;

        for (const pts of Object.values(clusters)) {
          const hull = turf.convex(
            turf.featureCollection(
              pts.map((p) => turf.point([p.lng, p.lat]))
            )
          );

          if (!hull) continue;

          const buffered = turf.buffer(hull, 0.2, { units: "kilometers" });
          const nearZone = turf.booleanPointInPolygon(userPoint, buffered);

          if (nearZone) {
            inAnyZone = true;

            const color = clusterColor(pts.length);
            const limit = getSpeedLimit(color);

            if (speedKmh > limit) {
              if (activeAlertRef.current !== "overspeed") {
                activeAlertRef.current = "overspeed";
                setZoneAlert(
                  `⚠️ Overspeed in ${color.toUpperCase()} zone! Limit ${limit} km/h`
                );
                speak("Reduce speed immediately", true);
              }
            } else {
              if (activeAlertRef.current !== "zone") {
                activeAlertRef.current = "zone";
                setZoneAlert(
                  `${color.toUpperCase()} zone. Maintain below ${limit} km/h`
                );
                speak("You are in a danger zone. Drive carefully");
              }
            }

            break;
          }
        }

        if (!inAnyZone && activeAlertRef.current !== null) {
          activeAlertRef.current = null;
          setZoneAlert("✅ You are in a safe zone");
          speak("You are now in a safe zone");
        }
      },
      (err) => console.log(err),
      { enableHighAccuracy: true }
    );
  }

  /* ---------------- UI ---------------- */

  return (
    <div style={{ height: "100vh", width: "100%" }}>
      {journeyStarted && (
        <div
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            background: "black",
            color: "white",
            padding: 12,
            borderRadius: 10,
            zIndex: 1000,
          }}
        >
          🚗 {speed.toFixed(1)} km/h
        </div>
      )}

      {zoneAlert && (
        <div className="alert-toast">
          {zoneAlert}
          <br />
          <button onClick={stopAlerts}>Stop</button>
        </div>
      )}

      {showPanel && (
  <div className="glass-panel">

    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }}>
      <h3 style={{ margin: 0 }}>🚘 Smart Navigator</h3>

      <button
        onClick={() => setShowPanel(false)}
        style={{
          background: "transparent",
          border: "none",
          fontSize: "18px",
          cursor: "pointer"
        }}
      >
        ❌
      </button>
    </div>
       

        
        <>
  <input
  type="text"
  placeholder="🔍 Search destination..."
  value={searchText}
  onChange={(e) => {
    const value = e.target.value;
    setSearchText(value);

    if (value.length > 2) {   // 👈 prevent empty spam
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        searchPlace(value);
      }, 400);
    }
  }}
  style={{
    width: "100%",
    padding: "10px",
    fontSize: "16px",   // 👈 VERY IMPORTANT for mobile
  }}
/>

    {suggestions.length > 0 && (
      <div
        style={{
          background: "white",
          maxHeight: "200px",
          overflowY: "auto",
          borderRadius: "6px",
          marginTop: "5px",
          boxShadow: "0 4px 10px rgba(0,0,0,0.2)",
        }}
      >
        {suggestions.map((place, index) => (
  <div
    key={index}
    onClick={() => {
      const lat = parseFloat(place.lat);
      const lon = parseFloat(place.lon);

      setDestination([lat, lon]);   // ✅ place marker
      setSearchText(place.display_name);
      setSuggestions([]);

      // ✅ reset previous routes
      setRouteOptions([]);
      setSelectedRoute(null);
    }}
    style={{
      padding: "8px",
      cursor: "pointer",
      borderBottom: "1px solid #eee",
    }}
  >
    {place.display_name}
  </div>
))}
      </div> 
    )}
  </>


        {userLocation && destination && routeOptions.length === 0 && (
          <button onClick={showRoutes}>🗺 Show Routes</button>
        )}

        {routeOptions.map((r) => {
  const severity = calculateRouteSeverity(r.coords);

  return (
    <div
      key={r.id}
      onClick={() => setSelectedRoute(r)}
      style={{
        padding: "8px",
        marginTop: "6px",
        borderRadius: "8px",
        cursor: "pointer",
        background:
          selectedRoute?.id === r.id ? "#d0f0ff" : "#f2f2f2",
        border:
          selectedRoute?.id === r.id
            ? "2px solid #00c6ff"
            : "1px solid #ccc",
      }}
    >
      🚗 Route {r.id + 1} <br />
      📏 {r.distance} km <br />
      ⏱ {r.duration} min <br />
      🚨 Severity: {severity}
    </div>
  );
})}

        {selectedRoute && !journeyStarted && (
          <button onClick={startJourney}>🚀 Start Journey</button>
        )}
      </div> )}

    
        <MapContainer
  center={userLocation || [15.55257, 73.75494]}
        zoom={13}
        style={{ height: "100%", width: "100%" }}
      >
        {!showPanel && (
  <button
  onClick={() => setShowPanel(true)}
  style={{
    position: "absolute",
    top: 20,
    left: 20,
    zIndex: 3000,
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(0,0,0,0.1)",
    background: "rgba(0, 0, 0, 0.75)",
    color: "#fff",
    fontWeight: "500",
    fontSize: "14px",
    backdropFilter: "blur(6px)",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
  }}
>
  ☰ Menu
</button>
)}
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        

        {userLocation && (
          <Marker position={userLocation} icon={pinIcon("blue")} />
        )}
        {destination && (
          <Marker position={destination} icon={pinIcon("green")} />
        )}

        {Object.entries(clusters).map(([id, pts]) => {
          const hull = turf.convex(
            turf.featureCollection(
              pts.map((p) => turf.point([p.lng, p.lat]))
            )
          );
          if (!hull) return null;

          const coords = hull.geometry.coordinates[0].map(
            ([lng, lat]) => [lat, lng]
          );

          const color = clusterColor(pts.length);

          return (
            <Polygon
              key={id}
              positions={coords}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.3,
              }}
            />
          );
        })}

        {routeOptions.map((r) => (
          <Polyline
            key={r.id}
            positions={r.coords}
            color={selectedRoute?.id === r.id ? "#00c6ff" : "#bbbbbb"}
weight={selectedRoute?.id === r.id ? 7 : 2}
opacity={selectedRoute?.id === r.id ? 1 : 0.5}
          />
        ))}
      </MapContainer>
    </div>
  );
}