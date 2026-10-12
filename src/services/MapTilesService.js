import Logger from "../util/Logger.js";

// Every map asset Home Assistant self-hosts for the vector base layer lives
// under this path and needs a short-lived token appended.
export const MAP_TILES_PATH = "/api/map_tiles";

// Core rotates the token roughly every 30 minutes and keeps the previous one
// valid, so refreshing at 20 minutes leaves plenty of headroom for a slow or
// missed round trip.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;

/**
 * Acquires and keeps fresh the token Home Assistant requires on every
 * `/api/map_tiles/` request (style, tilejson, vector tiles, glyphs, sprites).
 *
 * The token is fetched over the WebSocket connection (`map_tiles/access_token`)
 * rather than sent as a header, because MapLibre loads most of these assets
 * from a worker that carries neither the session cookie nor an auth header.
 * Appending the token to the URL is the only thing HA's proxy accepts, which is
 * the same approach the Home Assistant frontend takes.
 */
export default class MapTilesService {
  /** @type {object} the hass connection (has sendMessagePromise) */
  _connection;
  /** @type {string} origin the proxy is served from (usually this instance) */
  _origin;
  /** @type {string|undefined} the current token */
  _token;
  /** @type {ReturnType<typeof setInterval>|undefined} */
  _refreshInterval;

  /**
   * @param {object} connection the hass connection (this.hass.connection)
   * @param {string} [origin] origin the proxy is served from; defaults to the
   *   page origin, which is correct for a card served from within HA
   */
  constructor(connection, origin) {
    this._connection = connection;
    this._origin = (origin ?? location.origin).replace(/\/+$/, "");
  }

  /** @returns {string|undefined} the current token, if one has been acquired */
  get token() {
    return this._token;
  }

  /**
   * Fetches a token and schedules periodic refreshes. Never throws: without a
   * token the caller falls back to raster tiles.
   * @returns {Promise<string|undefined>} the acquired token, or undefined
   */
  async acquire() {
    try {
      await this._fetchToken();
    } catch (e) {
      Logger.warn(`[MapTiles]: could not acquire token: ${e}`);
      return undefined;
    }
    this._scheduleRefresh();
    return this._token;
  }

  /** Stops the refresh timer. */
  cleanup() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
  }

  /**
   * Makes a root-relative URL absolute by prefixing the instance origin, using
   * plain concatenation so MapLibre placeholders like `{fontstack}`, `{range}`
   * and `{z}` survive (a URL object would percent-encode the braces).
   *
   * MapLibre validates the style's sprite and glyphs URLs when it parses the
   * document and rejects relative ones outright, before `transformRequest` ever
   * runs, so these have to be absolute in the style itself. The token is added
   * later by withToken() when the request actually goes out.
   * @param {string} url a URL that may be root-relative (starts with "/")
   * @returns {string} the absolute URL
   */
  absoluteUrl(url) {
    if (typeof url === "string" && url.startsWith("/")) {
      return `${this._origin}${url}`;
    }
    return url;
  }

  /**
   * Rewrites a URL so MapLibre's request reaches HA's proxy with a valid token.
   *
   * Relative paths are resolved against the instance origin (MapLibre resolves
   * from a worker that has no document base URL, so the result must be
   * absolute). Only `/api/map_tiles/` URLs are touched; anything else is
   * returned unchanged so third-party sources still work. The URL is rebuilt by
   * concatenation elsewhere, but here URL/searchParams is safe: the token is a
   * hex string and the path segments carry no MapLibre placeholders once the
   * worker has substituted `{z}`/`{fontstack}` etc.
   * @param {string} url the URL MapLibre wants to fetch
   * @returns {string} the URL with the token appended when applicable
   */
  withToken(url) {
    let parsed;
    try {
      parsed = new URL(url, this._origin);
    } catch {
      return url;
    }
    if (!parsed.pathname.startsWith(`${MAP_TILES_PATH}/`) &&
        parsed.pathname !== `${MAP_TILES_PATH}/tilejson.json`) {
      return parsed.href;
    }
    // Rebuild against the instance origin: MapLibre first resolves the style's
    // relative paths against the page, which is not always the proxy host.
    const onInstance = new URL(`${this._origin}${parsed.pathname}${parsed.search}`);
    if (this._token) {
      onInstance.searchParams.set("token", this._token);
    }
    return onInstance.href;
  }

  async _fetchToken() {
    const result = await this._connection.sendMessagePromise({
      type: "map_tiles/access_token",
    });
    this._token = result?.token;
    if (!this._token) {
      throw new Error("map_tiles/access_token returned no token");
    }
    Logger.debug("[MapTiles]: token acquired");
  }

  _scheduleRefresh() {
    if (this._refreshInterval) {
      return;
    }
    this._refreshInterval = setInterval(() => {
      this._fetchToken().catch((e) => {
        // Keep the current token; the next interval retries.
        Logger.warn(`[MapTiles]: token refresh failed: ${e}`);
      });
    }, TOKEN_REFRESH_MS);
  }
}
