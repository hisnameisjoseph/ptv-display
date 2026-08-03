-- Melbourne Departures - bus stop reference schema
--
-- Reference data imported from the PTV API by import-bus-stops.mjs.
-- Metro buses only (route_type = 2). Roughly 18k stops, 40k stop-route links.
--
-- Bus ROUTES are stored in the existing `routes` table (route_type = 2),
-- not duplicated here. That table is created by schema.sql, so apply
-- schema.sql first if you are starting from scratch.
--
-- Apply locally:   npx wrangler d1 execute ptv-db --local  --file=./schema-bus.sql
-- Apply remote:    npx wrangler d1 execute ptv-db --remote --file=./schema-bus.sql

DROP TABLE IF EXISTS bus_stop_routes;
DROP TABLE IF EXISTS bus_stops;

-- ---- Bus stops -------------------------------------------------------------
-- One row per physical pole. Unlike train stations, a bus stop_id serves a
-- single direction of travel, so there is no station_type / split concept.
CREATE TABLE bus_stops (
  stop_id    INTEGER PRIMARY KEY,  -- PTV stop_id
  name       TEXT    NOT NULL,     -- e.g. "Moreland St/Hopkins St"
  suburb     TEXT,
  latitude   REAL,
  longitude  REAL
);

-- ---- Bus stop <-> Route (many-to-many) -------------------------------------
CREATE TABLE bus_stop_routes (
  stop_id   INTEGER NOT NULL,
  route_id  INTEGER NOT NULL,
  PRIMARY KEY (stop_id, route_id)
);

-- Name index helps the ORDER BY tiers in /api/stops/search. The subsequence
-- LIKE ('%m%c%') cannot use an index, but the prefix tier can.
CREATE INDEX idx_bus_stops_name       ON bus_stops(name);
CREATE INDEX idx_bus_stop_routes_stop ON bus_stop_routes(stop_id);
