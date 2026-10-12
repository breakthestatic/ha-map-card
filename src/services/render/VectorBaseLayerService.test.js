import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";

// The real adapter pulls in maplibre-gl, which does not import cleanly under
// jsdom. Mock it: importing the module normally registers L.maplibreGL, so we
// stub that factory on L instead and control what the layer does.
jest.mock("@maplibre/maplibre-gl-leaflet", () => ({}));

import L from "leaflet";
import VectorBaseLayerService, {
  supportsWebGL2,
  loadStyle,
  MAP_MIN_ZOOM,
  MAP_MAX_ZOOM,
  _resetWebGL2Cache,
} from "./VectorBaseLayerService";

// whenReady runs its callback synchronously (map already positioned), matching
// Leaflet's behaviour when the map has a view.
const makeMap = () => ({
  addLayer: jest.fn(),
  removeLayer: jest.fn(),
  whenReady: jest.fn((cb) => {
    cb();
    return this;
  }),
});

// The token service asks the connection for a token via sendMessagePromise.
const makeConnection = (token = "test-token") => ({
  sendMessagePromise: jest.fn().mockResolvedValue({ token }),
});

// A stand-in token service for loadStyle tests: withToken returns the URL
// unchanged (so the test asserts on what was fetched) and absoluteUrl prefixes
// the page origin the way the real service does.
const passthroughTiles = {
  withToken: (url) => url,
  absoluteUrl: (url) =>
    typeof url === "string" && url.startsWith("/")
      ? `${location.origin}${url}`
      : url,
};

describe("VectorBaseLayerService", () => {
  beforeEach(() => {
    // The WebGL2 probe result is memoized module-side; clear it so each test
    // controls whether WebGL2 appears available.
    _resetWebGL2Cache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
    delete L.maplibreGL;
  });

  describe("exports", () => {
    it("exposes the HA zoom range", () => {
      expect(MAP_MIN_ZOOM).toBe(1);
      expect(MAP_MAX_ZOOM).toBe(20);
    });
  });

  describe("supportsWebGL2", () => {
    it("returns false when no WebGL2 context is available", () => {
      // jsdom's canvas has no real WebGL2; return null cleanly to avoid its
      // "not implemented" console noise while exercising the same branch.
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => null,
      }));
      expect(supportsWebGL2()).toBe(false);
    });
  });

  describe("loadStyle", () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it("absolutizes sprite/glyph/source URLs while preserving placeholders", async () => {
      const raw = {
        sprite: [{ id: "basics", url: "/api/map_tiles/sprites/basics/sprites" }],
        glyphs: "/api/map_tiles/fonts/{fontstack}/{range}.pbf",
        sources: { s: { url: "/api/map_tiles/tilejson.json" } },
        layers: [],
      };
      global.fetch.mockResolvedValue({ ok: true, json: async () => raw });

      const style = await loadStyle("/static/map/light.json", passthroughTiles);

      // MapLibre rejects relative sprite/glyph URLs at parse time, so these are
      // made absolute here. The {fontstack}/{range} placeholders must survive
      // (not be percent-encoded), and no token is added at this stage.
      expect(style.sprite[0].url).toBe(
        `${location.origin}/api/map_tiles/sprites/basics/sprites`
      );
      expect(style.glyphs).toBe(
        `${location.origin}/api/map_tiles/fonts/{fontstack}/{range}.pbf`
      );
      expect(style.sources.s.url).toBe(
        `${location.origin}/api/map_tiles/tilejson.json`
      );
    });

    it("authorizes the style fetch through the token service", async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ sources: {}, layers: [] }),
      });
      const tiles = {
        withToken: jest.fn(
          (url) => `${url}?token=abc`
        ),
      };

      await loadStyle("/static/map/light.json", tiles);

      expect(tiles.withToken).toHaveBeenCalledWith("/static/map/light.json");
      expect(global.fetch).toHaveBeenCalledWith("/static/map/light.json?token=abc");
    });

    it("throws when the style cannot be fetched", async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 404 });

      await expect(
        loadStyle("/static/map/light.json", passthroughTiles)
      ).rejects.toThrow("404");
    });
  });

  describe("setup", () => {
    it("falls back to raster when WebGL2 is unavailable", async () => {
      // Return no WebGL2 context cleanly (jsdom's canvas would otherwise print
      // a "not implemented" error).
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => null,
      }));
      const rasterFallback = jest.fn();
      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback,
      });

      const result = await service.setup(false);

      expect(result).toBe(false);
      expect(service.isVector).toBe(false);
      expect(rasterFallback).toHaveBeenCalledTimes(1);
    });

    it("adds the vector layer when WebGL2 and MapLibre are available", async () => {
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => ({ getExtension: () => ({ loseContext: () => {} }) }),
      }));
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sources: {}, layers: [] }),
      });
      const addTo = jest.fn();
      L.maplibreGL = jest.fn(() => ({ addTo, remove: jest.fn() }));

      const rasterFallback = jest.fn();
      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback,
      });

      const result = await service.setup(false);

      expect(result).toBe(true);
      expect(service.isVector).toBe(true);
      expect(L.maplibreGL).toHaveBeenCalledTimes(1);
      expect(addTo).toHaveBeenCalledTimes(1);
      expect(rasterFallback).not.toHaveBeenCalled();

      // The layer is given a transformRequest that appends the token to
      // /api/map_tiles/ requests so tiles, glyphs and sprites are authorized.
      const { transformRequest } = L.maplibreGL.mock.calls[0][0];
      const rewritten = transformRequest(
        `${location.origin}/api/map_tiles/sprites/basics/sprites.png`
      ).url;
      expect(rewritten).toContain("token=test-token");
    });

    it("falls back to raster when adding the MapLibre layer throws", async () => {
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => ({ getExtension: () => ({ loseContext: () => {} }) }),
      }));
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sources: {}, layers: [] }),
      });
      L.maplibreGL = jest.fn(() => ({
        addTo: () => {
          throw new Error("WebGL context refused");
        },
        remove: jest.fn(),
      }));
      // The fallback logs a warning by design; keep test output quiet.
      jest.spyOn(console, "warn").mockImplementation(() => {});

      const rasterFallback = jest.fn();
      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback,
      });

      const result = await service.setup(false);

      expect(result).toBe(false);
      expect(service.isVector).toBe(false);
      expect(rasterFallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("setDarkMode", () => {
    it("is a no-op when running on the raster fallback", async () => {
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => null,
      }));
      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback: jest.fn(),
      });
      await service.setup(false); // no WebGL2 -> raster

      // Should not throw or attempt any fetch.
      global.fetch = jest.fn();
      service.setDarkMode(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("switches the vector style with a full reload once loaded", async () => {
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => ({ getExtension: () => ({ loseContext: () => {} }) }),
      }));
      const setStyle = jest.fn();
      // A MapLibre map whose initial style has already loaded.
      const maplibreMap = {
        setStyle,
        isStyleLoaded: () => true,
        once: jest.fn(),
      };
      L.maplibreGL = jest.fn(() => ({
        addTo: jest.fn(),
        remove: jest.fn(),
        getMaplibreMap: () => maplibreMap,
      }));

      const darkStyle = { sources: {}, layers: [], name: "dark" };
      global.fetch = jest
        .fn()
        // initial light style for setup()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: {}, layers: [] }) })
        // dark style for setDarkMode()
        .mockResolvedValueOnce({ ok: true, json: async () => darkStyle });

      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback: jest.fn(),
      });
      await service.setup(false);

      service.setDarkMode(true);
      // Let the style fetch promise resolve.
      await new Promise((r) => setTimeout(r, 0));

      // Applied immediately (style already loaded), rebuilding the whole style.
      expect(setStyle).toHaveBeenCalledTimes(1);
      expect(setStyle).toHaveBeenCalledWith(darkStyle, { diff: false });
      expect(maplibreMap.once).not.toHaveBeenCalled();
    });

    it("defers the style switch until the map's initial style has loaded", async () => {
      jest.spyOn(document, "createElement").mockImplementation(() => ({
        getContext: () => ({ getExtension: () => ({ loseContext: () => {} }) }),
      }));
      const setStyle = jest.fn();
      let loadHandler;
      // A MapLibre map whose initial style has not loaded yet.
      const maplibreMap = {
        setStyle,
        isStyleLoaded: () => false,
        once: jest.fn((event, handler) => {
          if (event === "load") loadHandler = handler;
        }),
      };
      L.maplibreGL = jest.fn(() => ({
        addTo: jest.fn(),
        remove: jest.fn(),
        getMaplibreMap: () => maplibreMap,
      }));

      const darkStyle = { sources: {}, layers: [], name: "dark" };
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: {}, layers: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => darkStyle });

      const service = new VectorBaseLayerService(makeMap(), {
        styleLightUrl: "/static/map/light.json",
        styleDarkUrl: "/static/map/dark.json",
        connection: makeConnection(),
        rasterFallback: jest.fn(),
      });
      await service.setup(false);

      service.setDarkMode(true);
      await new Promise((r) => setTimeout(r, 0));

      // Not applied yet; queued on the map's load event.
      expect(setStyle).not.toHaveBeenCalled();
      expect(maplibreMap.once).toHaveBeenCalledWith("load", expect.any(Function));

      // Once the initial style loads, the switch is applied.
      loadHandler();
      expect(setStyle).toHaveBeenCalledWith(darkStyle, { diff: false });
    });
  });
});
