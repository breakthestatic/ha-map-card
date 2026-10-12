import L from "leaflet";
import Logger from "../../util/Logger.js";
import MapTilesService from "../MapTilesService.js";

// Matches the zoom range Home Assistant uses for its MapLibre base layer.
// The floor is 1 because at Leaflet zoom 0 the maplibre-gl-leaflet adapter
// drives the MapLibre map to -1, outside its supported range.
export const MAP_MIN_ZOOM = 1;
export const MAP_MAX_ZOOM = 20;

let webGL2Supported;

/** Test-only: clears the memoized WebGL2 probe result. */
export function _resetWebGL2Cache() {
  webGL2Supported = undefined;
}

/**
 * Rules out browsers without WebGL2 (older iOS/Android, blocklisted drivers).
 * MapLibre needs WebGL2 even to draw raster sources, so without it we cannot
 * use the vector base layer at all and must fall back to Leaflet raster tiles.
 * The probe must not keep the context, which is a scarce resource.
 *
 * @returns {boolean}
 */
export function supportsWebGL2() {
  if (webGL2Supported === undefined) {
    try {
      const context = document.createElement("canvas").getContext("webgl2");
      webGL2Supported = Boolean(context);
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webGL2Supported = false;
    }
  }
  return webGL2Supported;
}

/**
 * Fetches a MapLibre style document and makes its sprite/glyph/source URLs
 * absolute.
 *
 * The style document itself lives under `/api/map_tiles/` and needs the token,
 * so the fetch URL is run through the token service. MapLibre validates the
 * sprite and glyph URLs while parsing the style and rejects relative ones
 * before `transformRequest` runs, so those must be made absolute here.
 * Absolutizing uses plain concatenation, so the {fontstack}/{range} glyph
 * placeholders survive (a URL object would percent-encode the braces). The
 * token is not added here; the `transformRequest` hook appends it to every
 * outgoing request instead.
 *
 * @param {string} url style document URL (may be relative to the HA origin)
 * @param {MapTilesService} tiles token service, also used to absolutize URLs
 * @returns {Promise<object>} the parsed, absolutized style
 */
export async function loadStyle(url, tiles) {
  const response = await fetch(tiles.withToken(url));
  if (!response.ok) {
    throw new Error(`Failed to fetch vector style ${url}: ${response.status}`);
  }
  const style = await response.json();

  if (typeof style.sprite === "string") {
    style.sprite = tiles.absoluteUrl(style.sprite);
  } else if (Array.isArray(style.sprite)) {
    style.sprite = style.sprite.map((sprite) => ({
      ...sprite,
      url: tiles.absoluteUrl(sprite.url),
    }));
  }

  if (typeof style.glyphs === "string") {
    style.glyphs = tiles.absoluteUrl(style.glyphs);
  }

  if (style.sources) {
    for (const source of Object.values(style.sources)) {
      if (source && typeof source.url === "string") {
        source.url = tiles.absoluteUrl(source.url);
      }
    }
  }

  return style;
}

/**
 * Manages the opt-in MapLibre GL vector base layer.
 *
 * Mirrors the approach Home Assistant took in frontend PR #53816: the base map
 * is drawn as vector tiles through maplibre-gl-leaflet using the style/glyphs/
 * sprites HA self-hosts under /static/map/, while everything else on the map
 * stays on Leaflet. If WebGL2 is missing, MapLibre fails to load, or the style
 * cannot be fetched, we fall back to the provided raster base layer.
 */
export default class VectorBaseLayerService {
  /** @type {L.Map} */
  map;
  /** @type {string} */
  styleLightUrl;
  /** @type {string} */
  styleDarkUrl;
  /** @type {() => void} */
  rasterFallback;

  /** @type {object|undefined} maplibre-gl-leaflet layer */
  _layer;
  /** @type {MapTilesService} authorizes every /api/map_tiles/ request */
  _tiles;
  /** @type {boolean} whether the vector layer is currently active */
  _vector = false;
  // Dark mode that is actually applied to the map, tracked apart from the
  // requested mode: a failed style fetch must roll back to what is displayed,
  // not to the opposite of what was asked for.
  _appliedDarkMode = false;
  _requestedDarkMode = false;
  // Styles are fetched, so only the newest request may touch the map.
  _latestRequest = 0;

  /**
   * @param {L.Map} map the Leaflet map
   * @param {object} options
   * @param {string} options.styleLightUrl light style document URL
   * @param {string} options.styleDarkUrl dark style document URL
   * @param {object} options.connection the hass connection (this.hass.connection),
   *   used to acquire the token HA requires on every /api/map_tiles/ request
   * @param {() => void} options.rasterFallback adds the raster base layer to the map
   */
  constructor(map, { styleLightUrl, styleDarkUrl, connection, rasterFallback }) {
    this.map = map;
    this.styleLightUrl = styleLightUrl;
    this.styleDarkUrl = styleDarkUrl;
    this.rasterFallback = rasterFallback;
    this._tiles = new MapTilesService(connection);
  }

  /** @returns {boolean} true if the vector base layer is active */
  get isVector() {
    return this._vector;
  }

  _styleUrl(darkMode) {
    return darkMode ? this.styleDarkUrl : this.styleLightUrl;
  }

  /**
   * Sets up the base layer. Adds the vector layer when possible, otherwise
   * invokes the raster fallback. Never throws: a failure here still leaves a
   * usable map via the fallback.
   *
   * @param {boolean} darkMode initial dark mode
   * @returns {Promise<boolean>} true if the vector layer was added
   */
  async setup(darkMode) {
    this._appliedDarkMode = darkMode;
    this._requestedDarkMode = darkMode;

    if (!supportsWebGL2()) {
      Logger.debug("[VectorBaseLayer]: WebGL2 unavailable, using raster fallback");
      this._useRasterFallback();
      return false;
    }

    // Load MapLibre and its Leaflet adapter lazily: it is a large dependency
    // and importing it registers L.maplibreGL as a side effect, so only pull it
    // in when the vector base layer is actually enabled. Importing it also
    // fails outside a browser (it needs TextDecoder etc.), which the raster
    // fallback then covers.
    try {
      await import("@maplibre/maplibre-gl-leaflet");
    } catch (e) {
      Logger.warn(`[VectorBaseLayer]: MapLibre adapter unavailable, using raster fallback: ${e}`);
      this._useRasterFallback();
      return false;
    }

    // Acquire the token HA requires on every /api/map_tiles/ request. Without
    // it the style, tiles, glyphs and sprites all come back 403. acquire()
    // never throws; a missing token just means those requests go out
    // unauthorized and the style fetch below fails into the raster fallback.
    await this._tiles.acquire();

    let style;
    try {
      style = await loadStyle(this._styleUrl(darkMode), this._tiles);
    } catch (e) {
      Logger.warn(`[VectorBaseLayer]: could not load style, using raster fallback: ${e}`);
      this._useRasterFallback();
      return false;
    }

    try {
      // The adapter builds its MapLibre map in onAdd, so a refused WebGL
      // context, a blocked worker or a rejected blob URL throws when the layer
      // is added. Keep addTo inside the guard so those cases fall back to
      // raster rather than leaving a half-initialized map.
      this._layer = L.maplibreGL({
        style,
        // Append the token to every /api/map_tiles/ request (tiles, glyphs,
        // sprites) MapLibre makes; other URLs pass through untouched.
        transformRequest: (url) => ({ url: this._tiles.withToken(url) }),
        // Draw CJK/kana/hangul with a device font so we rely on HA's smaller
        // shipped glyph set.
        localIdeographFontFamily: "sans-serif",
      });
      // The adapter reads map pane positions in onAdd, which only exist after
      // the map has a view. whenReady runs the callback immediately if the map
      // is already positioned, otherwise once it is - avoiding the
      // "_leaflet_pos of undefined" throw when the layer is added too early.
      // Mark the layer active up front so a dark-mode toggle arriving before
      // the (possibly deferred) add is honoured against the pending layer; the
      // add failure path below rolls it back to the raster fallback.
      this._vector = true;
      this.map.whenReady(() => {
        try {
          this._layer?.addTo(this.map);
          Logger.debug("[VectorBaseLayer]: vector base layer active");
        } catch (e) {
          Logger.warn(`[VectorBaseLayer]: MapLibre failed on add, using raster fallback: ${e}`);
          this._teardownLayer();
          this._useRasterFallback();
        }
      });
    } catch (e) {
      Logger.warn(`[VectorBaseLayer]: MapLibre failed, using raster fallback: ${e}`);
      this._teardownLayer();
      this._useRasterFallback();
      return false;
    }

    return this._vector;
  }

  /**
   * Switches the vector style between light and dark. No-op for the raster
   * fallback (its dark mode is handled by the CSS filter on the tile pane).
   *
   * @param {boolean} darkMode
   */
  setDarkMode(darkMode) {
    if (!this._vector || darkMode === this._requestedDarkMode) {
      return;
    }
    this._requestedDarkMode = darkMode;
    const request = ++this._latestRequest;
    Logger.debug(`[VectorBaseLayer]: switching to ${darkMode ? "dark" : "light"} style`);

    loadStyle(this._styleUrl(darkMode), this._tiles)
      .then((style) => {
        if (request !== this._latestRequest) {
          return;
        }
        this._appliedDarkMode = darkMode;
        this._applyStyle(style);
      })
      .catch((e) => {
        if (request === this._latestRequest) {
          // Roll back to what is displayed, not to the opposite of what was
          // asked, so the next toggle is not a permanent no-op.
          this._requestedDarkMode = this._appliedDarkMode;
        }
        Logger.warn(`[VectorBaseLayer]: dark mode switch failed: ${e}`);
      });
  }

  /** Removes the vector layer and its MapLibre map. */
  cleanup() {
    this._teardownLayer();
    this._tiles.cleanup();
    this._vector = false;
  }

  /**
   * Applies a style to the MapLibre map. Uses diff: false so the whole style
   * (background, layer paint, sprite) is rebuilt for the light/dark swap rather
   * than diffed, and defers until the map's initial style has loaded, since a
   * setStyle issued before the first style.load is dropped.
   *
   * @param {object} style
   */
  _applyStyle(style) {
    const glMap = this._layer?.getMaplibreMap?.();
    if (!glMap) {
      return;
    }
    const apply = () => glMap.setStyle(style, { diff: false });
    if (glMap.isStyleLoaded && glMap.isStyleLoaded()) {
      apply();
    } else {
      // once() fires after the initial style finishes loading.
      glMap.once ? glMap.once("load", apply) : apply();
    }
  }

  _teardownLayer() {
    if (this._layer) {
      try {
        this._layer.remove();
      } catch {
        // May never have finished being added.
      }
      this._layer = undefined;
    }
  }

  _useRasterFallback() {
    this._vector = false;
    this.rasterFallback?.();
  }
}
