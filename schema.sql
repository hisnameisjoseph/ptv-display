-- Melbourne Departures - station reference schema (Milestone 1)
--
-- Reference data imported from the PTV API by import-stations.mjs.
-- This is slow-changing structural data: populate once, refresh occasionally
-- (the network does change - e.g. the 2025 Metro Tunnel restructure).
--
-- Apply locally:   npx wrangler d1 execute ptv-db --local --file=./schema.sql
-- Apply remote:    npx wrangler d1 execute ptv-db --remote --file=./schema.sql

-- Drop in dependency order so the script is re-runnable during development.
DROP TABLE IF EXISTS station_routes;
DROP TABLE IF EXISTS stations;
DROP TABLE IF EXISTS routes;

-- ---- Routes (metro lines) --------------------------------------------------
CREATE TABLE routes (
  route_id     INTEGER PRIMARY KEY,   -- PTV route_id (1..17 for metro)
  route_type   INTEGER NOT NULL,      -- 0 = metro train
  name         TEXT    NOT NULL,      -- e.g. "Werribee"
  number       TEXT,                  -- route_number (often empty for trains)
  colour       TEXT                   -- official line hex, e.g. "F178AF"
);

-- ---- Stations --------------------------------------------------------------
-- station_type vocabulary:
--   through            - ordinary 2-direction station (the default majority)
--   terminus           - an endpoint of at least one line
--   interchange        - served by 3+ routes (lines converge)
--   loop               - underground City Loop station (Flagstaff, Parliament)
--   tunnel             - Metro Tunnel station (Anzac, Parkville, Arden)
--   flinders_street    - special (all services set down / terminate-ish)
--   southern_cross     - special (cross-city vs loop grouping)
--   melbourne_central  - special (loop vs Metro Tunnel grouping)
CREATE TABLE stations (
  stop_id       INTEGER PRIMARY KEY,  -- PTV stop_id
  name          TEXT    NOT NULL,     -- e.g. "Footscray Station"
  latitude      REAL,
  longitude     REAL,
  suburb        TEXT,
  station_type  TEXT    NOT NULL DEFAULT 'through',
  is_terminus   INTEGER NOT NULL DEFAULT 0  -- 0/1 boolean
);

-- ---- Station <-> Route (many-to-many) --------------------------------------
CREATE TABLE station_routes (
  stop_id   INTEGER NOT NULL,
  route_id  INTEGER NOT NULL,
  PRIMARY KEY (stop_id, route_id),
  FOREIGN KEY (stop_id)  REFERENCES stations(stop_id),
  FOREIGN KEY (route_id) REFERENCES routes(route_id)
);

-- Helpful indexes for the join and for "which lines serve this station".
CREATE INDEX idx_station_routes_route ON station_routes(route_id);
CREATE INDEX idx_stations_type        ON stations(station_type);