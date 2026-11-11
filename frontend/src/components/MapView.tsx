import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { MapConfig, Vehicle } from '../lib/types';

/**
 * Mapa interactivo (Leaflet). Se ve y se maneja como Google Maps: arrastrar,
 * zoom con la rueda o con dos dedos, marcadores y rutas. Por defecto usa
 * teselas de OpenStreetMap; el servidor de teselas se cambia en el .env
 * (MAP_TILE_URL) sin tocar código.
 *
 * Es un componente "declarativo": recibe marcadores y líneas y los mantiene
 * al día en cada render, sin volver a crear el mapa.
 */
export type MarkerKind = 'restaurant' | 'destination' | 'courier' | 'pin';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  kind: MarkerKind;
  label?: string; // texto corto dentro del marcador (D-2001, iniciales…)
  color?: string; // color de estado
  title?: string; // tooltip
  vehicle?: Vehicle;
  heading?: number | null;
  active?: boolean; // resaltado (seleccionado)
  stale?: boolean; // ubicación vieja (más de 2 min)
  onClick?: () => void;
}

export interface MapLine {
  id: string;
  points: Array<[number, number]>;
  color: string;
  dashed?: boolean;
  weight?: number;
}

export interface MapRing {
  id: string;
  lat: number;
  lng: number;
  radiusKm: number;
  color: string;
  label?: string;
}

interface MapViewProps {
  config: MapConfig;
  markers: MapMarker[];
  lines?: MapLine[];
  rings?: MapRing[];
  /** Incluye los anillos completos al encuadrar (ajustes de zonas). */
  fitRings?: boolean;
  /** Cuando cambia, el mapa se reencuadra para mostrar todos los marcadores. */
  fitKey?: string;
  center?: [number, number];
  zoom?: number;
  onMapClick?: (lat: number, lng: number) => void;
  /** Marcador que se puede arrastrar (elegir la dirección de entrega). */
  draggable?: { lat: number; lng: number; onMove: (lat: number, lng: number) => void };
  className?: string;
  ariaLabel: string;
}

const VEHICLE_SVG: Record<Vehicle, string> = {
  // Iconos simples dibujados a mano para no depender de imágenes externas.
  MOTO: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16h6l3-6h3M9 10h4"/>',
  BICI: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16l4-7h5l3 7M10 9l2 7"/>',
  CARRO: '<path d="M4 15l2-5h12l2 5v3H4z"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/>',
};

function markerIcon(marker: MapMarker): L.DivIcon {
  const color = marker.color ?? '#0C3B2E';
  const ring = marker.active ? 'box-shadow:0 0 0 4px rgba(255,255,255,.95),0 0 0 7px ' + color + ';' : '';
  if (marker.kind === 'restaurant') {
    return L.divIcon({
      className: 'fo-marker',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      html: `<div style="width:40px;height:40px;border-radius:14px;background:#0C3B2E;border:3px solid #FFC533;display:grid;place-items:center;box-shadow:0 4px 12px rgba(0,0,0,.3)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFC533" stroke-width="2.4" stroke-linecap="round"><path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 0-3 2-3 5s1 4 3 4v9"/></svg></div>`,
    });
  }
  if (marker.kind === 'courier') {
    const rotate = marker.heading != null ? `<div style="position:absolute;inset:-9px;transform:rotate(${marker.heading}deg)"><div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid ${color}"></div></div>` : '';
    return L.divIcon({
      className: 'fo-marker',
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      html: `<div style="position:relative;width:38px;height:38px;opacity:${marker.stale ? 0.55 : 1}">${rotate}
        <div style="width:38px;height:38px;border-radius:999px;background:${color};border:3px solid #fff;display:grid;place-items:center;box-shadow:0 4px 12px rgba(0,0,0,.35);${ring}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VEHICLE_SVG[marker.vehicle ?? 'MOTO']}</svg></div>
        ${marker.label ? `<div style="position:absolute;top:40px;left:50%;transform:translateX(-50%);white-space:nowrap;background:#111827;color:#fff;font:600 11px/1 system-ui;padding:3px 6px;border-radius:6px">${escapeHtml(marker.label)}</div>` : ''}
      </div>`,
    });
  }
  // Destino / pin: gota clásica de mapa.
  return L.divIcon({
    className: 'fo-marker',
    iconSize: [34, 44],
    iconAnchor: [17, 42],
    html: `<div style="position:relative;width:34px;height:44px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.3))">
      <svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 43C17 43 32 27 32 16A15 15 0 0 0 2 16c0 11 15 27 15 27z" fill="${color}" stroke="#fff" stroke-width="2.5"/></svg>
      <div style="position:absolute;top:7px;left:0;right:0;text-align:center;color:#fff;font:700 10px/18px system-ui">${marker.label ? escapeHtml(marker.label) : '●'}</div>
      ${marker.active ? `<div style="position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);width:14px;height:5px;border-radius:50%;background:${color};opacity:.5"></div>` : ''}
    </div>`,
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function MapView({ config, markers, lines = [], rings = [], fitRings = false, fitKey, center, zoom = 14, onMapClick, draggable, className = '', ariaLabel }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const dragMarker = useRef<L.Marker | null>(null);
  const clickHandler = useRef(onMapClick);
  clickHandler.current = onMapClick;
  const dragHandler = useRef(draggable?.onMove);
  dragHandler.current = draggable?.onMove;

  // Crear el mapa una sola vez
  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: true, attributionControl: true, zoomSnap: 0.25 }).setView(center ?? [4.65, -74.08], zoom);
    L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: 19 }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    instance.on('click', (event: L.LeafletMouseEvent) => clickHandler.current?.(event.latlng.lat, event.latlng.lng));
    map.current = instance;
    // El contenedor puede cambiar de tamaño (paneles que se abren): Leaflet necesita saberlo.
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Marcadores, líneas y anillos
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    for (const ring of rings) {
      L.circle([ring.lat, ring.lng], { radius: ring.radiusKm * 1000, color: ring.color, weight: 1.5, dashArray: '4 6', fillOpacity: 0.04, interactive: false })
        .bindTooltip(ring.label ?? '', { permanent: false })
        .addTo(group);
    }
    for (const line of lines) {
      if (line.points.length < 2) continue;
      L.polyline(line.points, { color: line.color, weight: line.weight ?? 4, opacity: 0.85, dashArray: line.dashed ? '8 10' : undefined, lineCap: 'round' }).addTo(group);
    }
    for (const marker of markers) {
      const m = L.marker([marker.lat, marker.lng], { icon: markerIcon(marker), title: marker.title, keyboard: Boolean(marker.onClick), zIndexOffset: marker.kind === 'courier' ? 1000 : marker.active ? 500 : 0 });
      if (marker.title) m.bindTooltip(marker.title, { direction: 'top', offset: [0, marker.kind === 'destination' ? -38 : -20] });
      if (marker.onClick) m.on('click', marker.onClick);
      m.addTo(group);
    }
  }, [markers, lines, rings]);

  // Marcador arrastrable
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (!draggable) {
      dragMarker.current?.remove();
      dragMarker.current = null;
      return;
    }
    if (!dragMarker.current) {
      dragMarker.current = L.marker([draggable.lat, draggable.lng], {
        draggable: true,
        autoPan: true,
        icon: markerIcon({ id: 'pin', lat: 0, lng: 0, kind: 'pin', color: '#E5484D', active: true }),
        zIndexOffset: 2000,
        title: 'Arrastra para ajustar la ubicación',
      })
        .on('dragend', (event) => {
          const { lat, lng } = (event.target as L.Marker).getLatLng();
          dragHandler.current?.(lat, lng);
        })
        .addTo(instance);
    } else {
      dragMarker.current.setLatLng([draggable.lat, draggable.lng]);
    }
  }, [draggable?.lat, draggable?.lng, Boolean(draggable)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Encuadre
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const points: L.LatLngExpression[] = markers.map((m) => [m.lat, m.lng]);
    if (draggable) points.push([draggable.lat, draggable.lng]);
    for (const line of lines) points.push(...line.points);
    if (fitRings) {
      for (const ring of rings) {
        const box = L.latLng(ring.lat, ring.lng).toBounds(ring.radiusKm * 2000);
        points.push(box.getNorthWest(), box.getSouthEast());
      }
    }
    if (points.length === 0) return;
    if (points.length === 1) instance.setView(points[0], Math.max(instance.getZoom(), 15));
    else instance.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Centro explícito (p. ej. "usar mi ubicación")
  useEffect(() => {
    if (center && map.current) map.current.setView(center, Math.max(map.current.getZoom(), 16));
  }, [center?.[0], center?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={container} className={`isolate z-0 bg-[#e8eae6] ${className}`} role="application" aria-label={ariaLabel} />;
}

/** "Abrir en Google Maps" con la ruta hasta el destino (para el repartidor). */
export const googleMapsDirections = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
