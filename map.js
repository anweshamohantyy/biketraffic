// Import Mapbox as an ESM module
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';

// Import D3 as an ES Module
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

// ── Mapbox setup ──────────────────────────────────────────────────────────────
// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1IjoiYTJtb2hhbnR5IiwiYSI6ImNtcDdrbHh2ZzA3b2oyeHB2MWl4OXM3emoifQ.AWDEG3EM7HmyyRglk_uUvw';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027], // Boston
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// ── Global state ──────────────────────────────────────────────────────────────
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute   = Array.from({ length: 1440 }, () => []);

// ── Helper functions (defined globally so they can be used anywhere) ───────────

/** Convert a station's lon/lat to SVG pixel coordinates via Mapbox. */
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

/** Format a number of minutes-since-midnight as HH:MM AM/PM. */
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

/** Return minutes elapsed since midnight for a Date object. */
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Retrieve trips from pre-bucketed arrays within ±60 min of `minute`.
 * If minute === -1, return all trips.
 */
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }
  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // Range crosses midnight
    return tripsByMinute
      .slice(minMinute)
      .concat(tripsByMinute.slice(0, maxMinute))
      .flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

/**
 * Compute arrivals, departures, and totalTraffic for each station,
 * filtered to trips within ±60 min of timeFilter (-1 = no filter).
 */
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    station.arrivals     = arrivals.get(id)   ?? 0;
    station.departures   = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ── Map load ──────────────────────────────────────────────────────────────────
map.on('load', async () => {

  // ── Bike lanes: Boston ────────────────────────────────────────────────────
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  const bikeLanePaint = {
    'line-color': '#32D400',
    'line-width': 3,
    'line-opacity': 0.5,
  };

  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLanePaint,
  });

  // ── Bike lanes: Cambridge ─────────────────────────────────────────────────
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLanePaint,
  });

  // ── Load station & trip data concurrently ─────────────────────────────────
  let jsonData, trips;

  try {
    [jsonData, trips] = await Promise.all([
      d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json'),
      d3.csv(
        'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
        (trip) => {
          trip.started_at = new Date(trip.started_at);
          trip.ended_at   = new Date(trip.ended_at);

          // Pre-bucket trips by departure and arrival minute
          const startMin = minutesSinceMidnight(trip.started_at);
          const endMin   = minutesSinceMidnight(trip.ended_at);
          departuresByMinute[startMin].push(trip);
          arrivalsByMinute[endMin].push(trip);

          return trip;
        },
      ),
    ]);
  } catch (error) {
    console.error('Error loading data:', error);
    return;
  }

  // Compute initial station traffic (all trips)
  let stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations loaded:', stations.length);

  // ── SVG overlay ───────────────────────────────────────────────────────────
  const svg = d3.select('#map').select('svg');

  // Scales
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

  // Draw circles (one per station)
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      stationFlow(d.departures / d.totalTraffic),
    )
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.NAME}\n${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // Position circles and keep them aligned on map movement
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move',    updatePositions);
  map.on('zoom',    updatePositions);
  map.on('resize',  updatePositions);
  map.on('moveend', updatePositions);

  // ── Slider / filtering ────────────────────────────────────────────────────
  const timeSlider    = document.getElementById('time-slider');
  const selectedTime  = document.getElementById('selected-time');
  const anyTimeLabel  = document.getElementById('any-time');

  /** Update circle sizes and colors for the given timeFilter. */
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Expand radius range when filtered so circles remain readable
    timeFilter === -1
      ? radiusScale.range([0, 25])
      : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.departures / d.totalTraffic),
      );
  }

  /** Sync slider value → displayed time text and scatter plot. */
  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent   = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent   = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay(); // initialise display
});
