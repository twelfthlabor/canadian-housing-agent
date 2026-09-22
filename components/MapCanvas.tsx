"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import geography from "@/public/geography/canada.json";
import type { CitySummary } from "@/lib/types";
import Icon from "./Icon";
import { cityName, compactMoney } from "./format";

const project = (lon: number, lat: number) => [(lon + 141) * 12, (72 - lat) * 24];
const initial = { x: 534, y: 390, scale: 0.69 };
const points = geography.cities as Record<string, { point: number[]; lon: number; lat: number }>;
const priority = ["toronto", "vancouver", "montreal", "calgary", "edmonton", "ottawa", "winnipeg", "halifax", "victoria", "st-johns", "saskatoon", "regina", "charlottetown", "fredericton"];
const provinceLabels = [
  { name: "BRITISH COLUMBIA", lon: -125.0, lat: 55.0 },
  { name: "ALBERTA", lon: -114.5, lat: 55.5 },
  { name: "SASKATCHEWAN", lon: -106.5, lat: 55.0 },
  { name: "MANITOBA", lon: -97.0, lat: 57.5 },
  { name: "ONTARIO", lon: -86.0, lat: 50.0 },
  { name: "QUEBEC", lon: -72.0, lat: 53.0 },
  { name: "NUNAVUT", lon: -95.0, lat: 66.0 },
];
const lakeLabels = [
  { name: "GREAT BEAR LAKE", lon: -120.5, lat: 66.0 },
  { name: "GREAT SLAVE LAKE", lon: -114.0, lat: 61.5 },
  { name: "LAKE WINNIPEG", lon: -97.2, lat: 52.5 },
  { name: "LAKE SUPERIOR", lon: -87.5, lat: 47.7 },
  { name: "LAKE HURON", lon: -82.5, lat: 44.8 },
  { name: "LAKE ONTARIO", lon: -77.85, lat: 43.62 },
  { name: "LAKE ERIE", lon: -81.05, lat: 42.08 },
  { name: "GEORGIAN BAY", lon: -80.72, lat: 45.38 },
];

type Props = {
  cities: Record<string, CitySummary>;
  visible: string[];
  selected: string;
  compared: string[];
  onSelect: (city: string) => void;
  children: React.ReactNode;
};

export default function MapCanvas({ cities, visible, selected, compared, onSelect, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 780 });
  const [camera, setCamera] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; camera: typeof initial } | null>(null);
  const [extent, setExtent] = useState<"canada" | "metros">("canada");
  const [headingBox, setHeadingBox] = useState({ left: 0, top: 0, right: 0, bottom: 0 });

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = heading.current, host = container.current;
    if (!element || !host) return;
    const box = element.getBoundingClientRect(), rect = host.getBoundingClientRect();
    setHeadingBox({ left: box.left - rect.left, top: box.top - rect.top, right: box.right - rect.left, bottom: box.bottom - rect.top });
  }, [size]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("button, a, .city-tray, .map-filter-message")) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const offsetX = event.clientX - rect.left - rect.width / 2;
      const offsetY = event.clientY - rect.top - rect.height / 2;
      setCamera(current => {
        const scale = Math.min(4, Math.max(.12, current.scale * Math.exp(-event.deltaY * .002)));
        return { x: current.x + offsetX / current.scale - offsetX / scale, y: current.y + offsetY / current.scale - offsetY / scale, scale };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => {
    const point = points[selected]?.point;
    if (!point) return;
    setCamera(current => {
      const x = (point[0] - current.x) * current.scale + size.width / 2;
      const y = (point[1] - current.y) * current.scale + size.height / 2;
      if (x < 90 || x > size.width - 90 || y < 140 || y > size.height - (size.width <= 640 ? 395 : 210)) {
        return { ...current, x: point[0], y: point[1] + 80 / current.scale };
      }
      return current;
    });
  }, [selected, size.width, size.height]);

  function fit(canada: boolean) {
    setExtent(canada ? "canada" : "metros");
    // Canada frames the lon -141..-52, lat 42..72 country frame; metros fits the priority cities.
    const coords = (canada ? [project(-141, 72), project(-52, 42)] : priority.filter(city => points[city]).map(city => points[city].point));
    const xs = coords.map(p => p[0]);
    const ys = coords.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.max(.12, Math.min((size.width - 120) / (maxX - minX), (size.height - (size.width <= 640 ? 490 : 280)) / (maxY - minY), 1.4));
    setCamera({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 + (size.width <= 640 ? 150 / scale : 30), scale });
  }

  function zoom(factor: number) {
    setCamera(current => ({ ...current, scale: Math.min(4, Math.max(.12, current.scale * factor)) }));
  }

  const markers = useMemo(() => {
    const ordered = Array.from(new Set([selected, ...compared, ...priority, ...visible])).filter(city => visible.includes(city));
    const placed: { x: number; y: number }[] = [];
    const markers = ordered.flatMap(city => {
      const point = points[city]?.point;
      if (!point) return [];
      const x = (point[0] - camera.x) * camera.scale + size.width / 2;
      const y = (point[1] - camera.y) * camera.scale + size.height / 2;
      if (x < 12 || x > size.width - 12 || y < 10 || y > size.height - 12) return [];
      if (size.width <= 640 && y > size.height - (size.height < 650 ? 315 : 345)) return [];
      const offsets = [[-43, -55], [18, -34], [-105, -34], [-43, 18], [18, -85], [-105, -85], [18, 40], [-105, 40], [18, 85]];
      let label: { x: number; y: number } | undefined;
      if (priority.includes(city) || selected === city || camera.scale > 1.8) {
        for (const [dx, dy] of offsets) {
          const lx = x + dx, ly = y + dy;
          const underTitle = lx < (size.width <= 640 ? 255 : 300) && ly < (size.width <= 640 && size.height < 650 ? 100 : 170);
          const underHeading = (lx < headingBox.right && ly < headingBox.bottom) || underTitle;
          const underTray = size.width > 640 && lx + 110 > size.width - 345 && ly + 60 > size.height - 360;
          if (lx < 12 || lx > size.width - 110 || ly < 70 || ly > size.height - (size.width <= 640 ? (size.height < 650 ? 395 : 450) : 80) || underHeading || underTray) continue;
          if (!placed.some(p => Math.abs(p.x - lx) < 104 && Math.abs(p.y - ly) < 65)) {
            label = { x: lx, y: ly };
            placed.push(label);
            break;
          }
        }
      }
      return [{ city, x, y, label }];
    });
    // Paint priority majors last so the visible dot in a dense stack selects the major city.
    markers.sort((a, b) => Number(priority.includes(a.city)) - Number(priority.includes(b.city)));
    return markers;
  }, [visible, selected, compared, camera, size, headingBox]);

  return <div className={`map-canvas${dragging ? " is-dragging" : ""}`} ref={container}>
    <div className="map-surface"
      onPointerDown={event => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, camera };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        const start = drag.current;
        setCamera({ ...start.camera, x: start.camera.x - (event.clientX - start.x) / start.camera.scale, y: start.camera.y - (event.clientY - start.y) / start.camera.scale });
      }}
      onPointerUp={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => zoom(1.4)}
      aria-hidden="true">
      <svg className="basemap" viewBox={`${camera.x - size.width / camera.scale / 2} ${camera.y - size.height / camera.scale / 2} ${size.width / camera.scale} ${size.height / camera.scale}`}>
        <defs><pattern id="land-grain" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".45" fill="#71837b" opacity=".12" /></pattern></defs>
        {geography.regions.map(region => <g key={region.name}><path d={region.path} className="land" /><path d={region.path} fill="url(#land-grain)" /></g>)}
        {geography.lakes.map(lake => <path key={lake.name} className="lake" d={lake.path} />)}
      </svg>
    </div>
    <div className="map-labels" aria-hidden="true">
      {provinceLabels.map(province => {
        const p = project(province.lon, province.lat);
        const left = (p[0] - camera.x) * camera.scale + size.width / 2;
        const top = (p[1] - camera.y) * camera.scale + size.height / 2;
        const half = province.name.length * 8.5 + 4;
        if (left + half > headingBox.left && left - half < headingBox.right && top + 10 > headingBox.top && top - 10 < headingBox.bottom) return null;
        return <span className="province-label" key={province.name} style={{ left, top }}>{province.name}</span>;
      })}
      {lakeLabels.map(lake => {
        const p = project(lake.lon, lake.lat);
        const left = (p[0] - camera.x) * camera.scale + size.width / 2;
        const top = (p[1] - camera.y) * camera.scale + size.height / 2;
        // Yield to the heading: rough 9px mono label box against the measured heading rect.
        const half = lake.name.length * 3.9 + 4;
        if (left + half > headingBox.left && left - half < headingBox.right && top + 7 > headingBox.top && top - 7 < headingBox.bottom) return null;
        return <span className="lake-label" key={lake.name} style={{ left, top }}>{lake.name}</span>;
      })}
    </div>
    <svg className="marker-leaders" aria-hidden="true" width={size.width} height={size.height}>
      {markers.filter(m => m.label).map(m => <path key={m.city} d={`M${m.x},${m.y}L${m.label!.x + 43},${m.label!.y + 27}`} className={m.city === selected ? "selected" : ""} />)}
    </svg>
    <div className="map-points">
      {markers.map(marker => <div key={marker.city}>
        <button className={`city-point${marker.city === selected ? " selected" : ""}`} style={{ left: marker.x, top: marker.y }} onClick={() => onSelect(marker.city)} aria-label={`Select ${cityName(marker.city)}, median ${compactMoney(cities[marker.city].medianPrice)}`} aria-pressed={marker.city === selected} />
        {marker.label ? <button className={`price-marker${marker.city === selected ? " selected" : ""}`} style={{ left: marker.label.x, top: marker.label.y }} onClick={() => onSelect(marker.city)} aria-pressed={marker.city === selected}><strong>{compactMoney(cities[marker.city].medianPrice)}</strong><span>{cityName(marker.city)}</span></button> : null}
      </div>)}
    </div>
    <div className="map-heading" ref={heading}><span className="micro-label">THE HOUSING ATLAS</span><h1>Canada,<br /><span>in perspective.</span></h1><p>Select a place. See what’s asking.</p></div>
    <div className="map-region-control" role="group" aria-label="Map extent"><button aria-pressed={extent === "canada"} onClick={() => fit(true)}>Canada</button><button aria-pressed={extent === "metros"} onClick={() => fit(false)}>Major metros</button></div>
    <div className="map-controls"><div className="zoom-controls"><button onClick={() => zoom(1.3)} aria-label="Zoom in"><Icon name="plus" /></button><button onClick={() => zoom(1 / 1.3)} aria-label="Zoom out"><Icon name="minus" /></button></div><button className="recenter" aria-label="Reset map" onClick={() => fit(extent === "canada")}><Icon name="locate" /></button></div>
    <div className="map-compass" aria-hidden="true"><span>N</span><Icon name="send" /></div>
    {children}
    <div className="map-attribution"><span>City reference points · Not individual listings</span><span><a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a> / <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a></span></div>
  </div>;
}
