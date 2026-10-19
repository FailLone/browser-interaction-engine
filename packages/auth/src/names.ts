/** Who a preset logs in as: site (e.g. `global`), market and legal entity (e.g. `eid14`). */
export interface PresetIdentity {
  preset: string;
  site: string;
  market: string;
  entity: string;
}

/** Hosts whose preset names follow another convention supply their own parser. */
export type PresetNameParser = (name: string) => PresetIdentity;

/**
 * `site-entity` or `site-market-entity`, lower case: `global-eid14` is site `global`, market
 * `global` (a site without a market part is its own market), entity `eid14`. A `.enc` suffix
 * and directories are ignored, so a file name can be passed as is.
 */
export const parsePresetName: PresetNameParser = name => {
  const preset = name
    .replace(/^.*[\\/]/, '')
    .replace(/\.enc$/i, '')
    .replace(/\.preset$/i, '');
  const match = /^([a-z][a-z0-9]*)(?:-([a-z][a-z0-9]*))?-([a-z]+\d+)$/.exec(preset);
  if (!match) throw new Error(`Preset name "${preset}" is not site[-market]-entity, e.g. global-eid14`);
  const [, site, market, entity] = match;
  return { preset, site: site!, market: market ?? site!, entity: entity! };
};
