'use strict';

/*
 * File-backed lead store. Persistence is isolated here so it can later be replaced (for example by a
 * database) without touching the HTTP layer. Writes are serialised and atomic (temp file + rename).
 */

const fs = require('node:fs');
const path = require('node:path');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

class FileLeadStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.leads = new Map();
    this.writeChain = Promise.resolve();
    this.lastSeenMtimeMs = null;
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.reload();
    return this;
  }

  async reload() {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this.leads = new Map(Object.entries(data.leads || {}));
      this.lastSeenMtimeMs = (await fs.promises.stat(this.filePath)).mtimeMs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.leads = new Map();
      this.lastSeenMtimeMs = null;
    }
  }

  // Pick up changes made by the admin CLI while the server is running.
  async refreshIfChanged() {
    try {
      const { mtimeMs } = await fs.promises.stat(this.filePath);
      if (this.lastSeenMtimeMs !== null && mtimeMs !== this.lastSeenMtimeMs) await this.reload();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  has(id) {
    return this.leads.has(id);
  }

  get(id) {
    return clone(this.leads.get(id));
  }

  list() {
    return Array.from(this.leads.values(), clone);
  }

  async insert(lead) {
    await this.refreshIfChanged();
    if (this.leads.has(lead.id)) throw new Error(`Lead ${lead.id} already exists`);
    this.leads.set(lead.id, clone(lead));
    try {
      await this.persist();
    } catch (error) {
      this.leads.delete(lead.id);
      throw error;
    }
    return clone(lead);
  }

  /** Apply `mutate(copy)` to a lead and persist. Returns the updated lead, or null if not found. */
  async update(id, mutate) {
    await this.refreshIfChanged();
    const current = this.leads.get(id);
    if (!current) return null;
    const next = clone(current);
    mutate(next);
    this.leads.set(id, next);
    try {
      await this.persist();
    } catch (error) {
      this.leads.set(id, current);
      throw error;
    }
    return clone(next);
  }

  async delete(id) {
    await this.refreshIfChanged();
    const current = this.leads.get(id);
    if (!current) return false;
    this.leads.delete(id);
    try {
      await this.persist();
    } catch (error) {
      this.leads.set(id, current);
      throw error;
    }
    return true;
  }

  /** Delete unsubmitted drafts older than the retention window. Returns the number removed. */
  async purgeDrafts(maxAgeMs, now = Date.now()) {
    await this.refreshIfChanged();
    const expired = Array.from(this.leads.values()).filter(
      (lead) => lead.status === 'DRAFT' && now - Date.parse(lead.updatedAt) > maxAgeMs
    );
    if (!expired.length) return 0;
    expired.forEach((lead) => this.leads.delete(lead.id));
    await this.persist();
    return expired.length;
  }

  persist() {
    const snapshot = JSON.stringify({ version: 1, leads: Object.fromEntries(this.leads) }, null, 2);
    const run = async () => {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tempPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tempPath, this.filePath);
      this.lastSeenMtimeMs = (await fs.promises.stat(this.filePath)).mtimeMs;
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => {});
    return result;
  }
}

module.exports = { FileLeadStore };
