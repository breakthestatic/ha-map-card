import { LayerGroup } from 'leaflet';
import EntityHistory from './EntityHistory';
import HaMapUtilities from '../util/HaMapUtilities';
import HaHistoryService from '../services/HaHistoryService';
import HaDateRangeService from '../services/HaDateRangeService';
import HaLinkedEntityService from '../services/HaLinkedEntityService';
import Entity from './Entity';
import Logger from '../util/Logger';
import TimelineEntry from './TimelineEntry';

export default class EntityHistoryManager {
  /** @type {Entity} */
  entity;
  /** @type {LayerGroup} */
  historyLayerGroup;
  /** @type {Date} */
  currentHistoryStart;
  /** @type {Date} */
  currentHistoryEnd;
  /** @type {HaHistoryService} */
  historyService;
  /** @type {HaDateRangeService} */
  dateRangeManager;
  /** @type {HaLinkedEntityService} */
  linkedEntityService;
  /** @type {EntityHistory} */
  history;
  /** @type {number} */
  updateTimeout;

  constructor(entity, historyService, dateRangeManager, linkedEntityService) {
    this.entity = entity;
    this.historyService = historyService;
    this.dateRangeManager = dateRangeManager;
    this.linkedEntityService = linkedEntityService;
  }

  get hasHistory() {
    return this.entity.config.hasHistory;
  }

  setup() {
    this.setupListeners();

    if (this.hasHistory) {
      this.historyLayerGroup = new LayerGroup();
      this.entity.map.addLayer(this.historyLayerGroup);         

      this.history?.update().flat().forEach((marker) => {
        marker.addTo(this.historyLayerGroup);
      });
    }
  }

  setupListeners() {
    const historyStart = this.entity.config.historyStart ?? new Date(Date.now() - 10 * 1000);
    this.currentHistoryStart = historyStart;
    this.currentHistoryEnd = this.entity.config.historyEnd;
    
    // Subscribe immediately before setting up listeners
    this.subscribeHistory(historyStart, this.entity.config.historyEnd);

    if (this.entity.config.usingDateRangeManager) {
      Logger.debug(`[EntityHistoryManager] Using date range manager for ${this.entity.id}`);
      this.dateRangeManager.onDateRangeChange((range) => {
        this.setHistoryDates(range.start, range.end);
        this.refreshHistory();
      });
    }

    if (this.entity.config.historyStartEntity) {
      Logger.debug(`[EntityHistoryManager] Using history start entity for ${this.entity.id}`);
      this.linkedEntityService.onStateChange(
        this.entity.config.historyStartEntity,
        (newState) => {
          const date = HaMapUtilities.getEntityHistoryDate(newState, this.entity.config.historyStartEntitySuffix);
          this.setHistoryDates(date, this.currentHistoryEnd);
          this.refreshHistory();
        }
      );
    }

    if (this.entity.config.historyEndEntity) {
      Logger.debug(`[EntityHistoryManager] Using history end entity for ${this.entity.id}`);
      this.linkedEntityService.onStateChange(
        this.entity.config.historyEndEntity,
        (newState) => {
          const date = HaMapUtilities.getEntityHistoryDate(newState, this.entity.config.historyEndEntitySuffix);
          this.setHistoryDates(this.currentHistoryStart, date);
          this.refreshHistory();
        }
      );
    }
  }

  setHistoryDates(start, end) {
    this.currentHistoryStart = start;
    this.currentHistoryEnd = end;
  }

  refreshHistory() {
    Logger.debug(`[EntityHistoryManager] Refreshing history for ${this.entity.id}: ${this.currentHistoryStart} -> ${this.currentHistoryEnd}`);
    this.historyLayerGroup.clearLayers();
    this.subscribeHistory(this.currentHistoryStart, this.currentHistoryEnd);
  }

  subscribeHistory(start, end) {
    if(this.hasHistory) {
      this.history = new EntityHistory(this.entity.id, this.entity.tooltip, this.entity.config.historyLineColor, this.entity.config.gradualOpacity, this.entity.config.historyShowDots, this.entity.config.historyShowLines);
    }
    this.historyService.subscribe(this.entity.id, start, end, this.react.bind(this), this.entity.config.useBaseEntityOnly);
  }

  /** @param {TimelineEntry} entry */
  react = (entry) => {
    if(entry.originalEntityId != this.entity.id) {
      return;
    }

    if(this.hasHistory) {
      this.history.react(entry);
      if (this.updateTimeout) clearTimeout(this.updateTimeout);
      this.updateTimeout = setTimeout(() => this.update(), 100);
    }
    this.entity.react(entry);
  }

  

  update() {
    if(!this.hasHistory) {
      return;
    }
    this.history?.update().flat().forEach((marker) => {
      marker.addTo(this.historyLayerGroup);
    });
  }
}