/**
 * Cálculos de distancia y tiempo para domicilios.
 *
 * La distancia es en línea recta (haversine). Las calles no van en línea
 * recta, así que el tiempo estimado se infla con ROUTE_FACTOR. Para rutas y
 * tiempos reales por calles se conecta un motor de rutas (OSRM, Google
 * Directions, Mapbox) en un solo lugar: estimateTravelMinutes().
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const ROUTE_FACTOR = 1.35; // calles vs. línea recta, valor típico en ciudad

/** Velocidad media en ciudad por tipo de vehículo, en km/h. */
export const VEHICLE_SPEED_KMH = { MOTO: 25, BICI: 13, CARRO: 20 } as const;
export type Vehicle = keyof typeof VEHICLE_SPEED_KMH;

export function distanceKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function estimateTravelMinutes(from: LatLng, to: LatLng, vehicle: Vehicle = 'MOTO'): number {
  const km = distanceKm(from, to) * ROUTE_FACTOR;
  return Math.max(1, Math.round((km / VEHICLE_SPEED_KMH[vehicle]) * 60));
}

export const isValidLatLng = (p: Partial<LatLng>): p is LatLng =>
  typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
