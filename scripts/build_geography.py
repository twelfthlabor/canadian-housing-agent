"""Build an offline display basemap from Natural Earth and GeoNames.

Inputs downloaded to output/research (URLs in docs/FRONTEND-RESEARCH.md).
This is cartographic context only; it does not modify listing data.

Canada-wide equirectangular projection (MapCanvas.tsx mirrors it in JS):
    x = (lon + 141) * 12
    y = (72 - lat) * 24
12 units per degree of longitude, 24 per degree of latitude (the ~2:1
vertical stretch compensates for meridian convergence at high latitudes).
Origin is the top-left frame corner at lon -141, lat 72, roughly covering
lon -141..-52, lat 42..72. Values stay in the same magnitude as the old
Ontario-tuned x=(lon+85)*110, y=(49-lat)*155 scheme.
"""
import collections
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
research = ROOT / 'output/research'

LON0, LAT0, KX, KY = -141, 72, 12, 24

CANADA = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick',
          'Newfoundland and Labrador', 'Northwest Territories',
          'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
          'Québec', 'Saskatchewan', 'Yukon']
LAKES = ['Lake Ontario', 'Lake Erie', 'Lake Huron', 'Lake Michigan',
         'Lake Superior', 'Lake Simcoe', 'Lake Nipissing',
         'Great Bear Lake', 'Great Slave Lake', 'Lake Winnipeg',
         'Lake Athabasca', 'Reindeer Lake', 'Lake Nipigon',
         'Lake of the Woods']
# GeoNames admin1 codes for the dataset's province abbreviations.
ADMIN1 = {'AB': '01', 'BC': '02', 'MB': '03', 'NB': '04', 'NL': '05',
          'NS': '07', 'ON': '08', 'PE': '09', 'QC': '10', 'SK': '11',
          'YT': '12', 'NT': '13', 'NU': '14'}

def project(lon, lat):
    return [round((lon - LON0) * KX, 2), round((LAT0 - lat) * KY, 2)]

def path(geometry):
    polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    parts = []
    for polygon in polygons:
        for ring in polygon:
            points = [project(*coord[:2]) for coord in ring]
            parts.append('M' + 'L'.join(f'{x},{y}' for x, y in points) + 'Z')
    return ''.join(parts)

provinces = json.loads((research / 'provinces.geojson').read_text())['features']
regions = []
for feature in provinces:
    if feature['properties']['name'] in CANADA:
        regions.append({'name': feature['properties']['name'], 'path': path(feature['geometry'])})
lakes = []
for feature in json.loads((research / 'lakes.geojson').read_text())['features']:
    if feature['properties']['name'] in LAKES:
        lakes.append({'name': feature['properties']['name'], 'path': path(feature['geometry'])})

with zipfile.ZipFile(research / 'CA.zip') as archive:
    rows = [line.split('\t') for line in archive.read('CA.txt').decode().splitlines()]
rows = [r for r in rows if r[6] in ('P', 'A')]
province_of = collections.defaultdict(collections.Counter)
for row in json.loads((ROOT / 'data/listings.json').read_text()):
    province_of[row['city']][row['province']] += 1
expected = {city: counts.most_common(1)[0][0] for city, counts in province_of.items()}
normalize = lambda value: value.lower().replace('.', '').replace('-', ' ').strip()
cities = {}
for slug in json.loads((ROOT / 'data/market_summary.json').read_text())['cities']:
    matches = [r for r in rows if normalize(slug) in [normalize(name) for name in [r[1], r[2]] + r[3].split(',')] ]
    # Prefer the dataset's province, then a populated place, then population.
    matches.sort(key=lambda r: (r[10] != ADMIN1.get(expected.get(slug, ''), ''), r[6] != 'P', -int(r[14] or 0)))
    if not matches:
        print(f'warning: no GeoNames match for {slug}', file=sys.stderr)
        continue
    row = matches[0]
    lon, lat = float(row[5]), float(row[4])
    cities[slug] = {'lon': lon, 'lat': lat, 'point': project(lon, lat), 'geonameId': row[0]}

output = ROOT / 'public/geography/canada.json'
output.write_text(json.dumps({'regions': regions, 'lakes': lakes, 'cities': cities}, separators=(',', ':')) + '\n')
print(f'{len(cities)} city reference points, {len(regions)} regions, {len(lakes)} lakes; {output.stat().st_size:,} bytes')
