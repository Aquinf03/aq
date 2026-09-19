/**
 * Shared macOS titlebar chrome — thin top strip for drag + traffic lights.
 */
export const TITLEBAR_H = 36;
export const TRAFFIC_LIGHT_SIZE = 14;
export const TRAFFIC_LIGHT_GAP = 8;
export const TRAFFIC_LIGHT_X = 14;
/** Higher = closer to the window top. */
export const TRAFFIC_LIGHT_Y = 10;
export const TRAFFIC_CLUSTER_W =
  3 * TRAFFIC_LIGHT_SIZE + 2 * TRAFFIC_LIGHT_GAP; /* 58 */
export const AFTER_LIGHTS_GAP = 12;
export const TRAFFIC_LIGHT_PAD = TRAFFIC_LIGHT_X + TRAFFIC_CLUSTER_W + AFTER_LIGHTS_GAP;
export const SIDEBAR_W = 240;
export const TOGGLE_BTN = 28;
export const TOGGLE_SLOT = 36;

export function trafficLightPosition() {
  return { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y };
}

export function toggleTop() {
  return TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_SIZE / 2 - TOGGLE_BTN / 2;
}
