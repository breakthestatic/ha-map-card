import MapConfig from "./MapConfig.js";
import L from "leaflet";
import { describe, expect, it } from "@jest/globals";

describe("MapConfig", () => {
  describe("constructor", () => {
    it("mapOptions", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        map_options: { dragging: true },
      });

      expect(mapConfig.mapOptions.dragging).toBe(true);
    });

    it("allows disabling the default tile layer", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        tile_layer_url: "",
      });

      expect(mapConfig.tileLayer).toBeNull();
    });

    it("normalizes simple CRS", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        map_options: { crs: "simple", minZoom: -4 },
      });

      expect(mapConfig.mapOptions.crs).toBe(L.CRS.Simple);
      expect(mapConfig.mapOptions.minZoom).toBe(-4);
    });

    it("complains when neither a [X, Y], an entity or a focus entity is given", () => {
      expect(() =>  new MapConfig({})).toThrowError("We need a map latitude & longitude; set at least [x, y], a focus_entity or have at least 1 entities defined.");
    });

    it("defaults the vector base layer to disabled with HA's self-hosted styles", () => {
      const mapConfig = new MapConfig({ x: 0.1, y: 0.1 });

      expect(mapConfig.vectorBaseLayer).toBe(false);
      expect(mapConfig.vectorBaseLayerStyleLight).toBe("/static/map/light.json");
      expect(mapConfig.vectorBaseLayerStyleDark).toBe("/static/map/dark.json");
    });

    it("enables the vector base layer when opted in", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        vector_base_layer: true,
      });

      expect(mapConfig.vectorBaseLayer).toBe(true);
    });

    it("allows overriding the vector style URLs", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        vector_base_layer: true,
        vector_base_layer_style_light: "/local/my-light.json",
        vector_base_layer_style_dark: "/local/my-dark.json",
      });

      expect(mapConfig.vectorBaseLayerStyleLight).toBe("/local/my-light.json");
      expect(mapConfig.vectorBaseLayerStyleDark).toBe("/local/my-dark.json");
    });

    it("keeps the raster tile layer as the fallback base layer when vector is enabled", () => {
      const mapConfig = new MapConfig({
        x: 0.1,
        y: 0.1,
        vector_base_layer: true,
      });

      // The raster tile layer is still configured so it can serve as fallback.
      expect(mapConfig.tileLayer).not.toBeNull();
      expect(mapConfig.tileLayer.url).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    });

  });
});
