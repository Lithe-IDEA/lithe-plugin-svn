// Plugin views (contract/v1/README.md, "Plugin views"): the check that the
// params of a view function are a view event. The Rust and Java SDKs apply
// the same rules when they parse the event.

import { PluginSdkError } from './errors.mjs';

const KINDS = new Set([
  'open', 'close', 'click', 'change', 'select', 'activate', 'viewport', 'resize', 'settings',
  'refresh', 'expand', 'loadMore',
]);
const OPTIONAL_TEXT = ['node', 'canvas', 'setting', 'item', 'cursor'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isAbsent = (value) => value === undefined || value === null;
const isOptionalText = (value) => isAbsent(value) || typeof value === 'string';

/**
 * Returns `params` when they are a view event and throws
 * `sdk.view.invalidEvent` when a required field is missing or a field has the
 * wrong type. An optional field that is `null` counts as absent.
 */
export function checkViewEvent(params) {
  const invalid = () => new PluginSdkError('sdk.view.invalidEvent', 'Invalid view event.');
  if (!isObject(params) || !KINDS.has(params.event)) throw invalid();
  if (typeof params.instance !== 'string' || typeof params.language !== 'string') throw invalid();
  const { surface, settings, value, viewport, width } = params;
  if (!isObject(surface) || !isOptionalText(surface.toolWindowID) || !isOptionalText(surface.settingRegionID)
      || isAbsent(surface.toolWindowID) === isAbsent(surface.settingRegionID)) {
    throw invalid();
  }
  if (!isObject(settings) || !isObject(settings.effective) || !isObject(settings.draft)) throw invalid();
  if (!OPTIONAL_TEXT.every((key) => isOptionalText(params[key]))) throw invalid();
  if (!isAbsent(value) && !['string', 'boolean', 'number'].includes(typeof value)) throw invalid();
  if (!isAbsent(viewport) && !(isObject(viewport)
      && ['x', 'y', 'width', 'height'].every((key) => typeof viewport[key] === 'number'))) {
    throw invalid();
  }
  if (!isAbsent(width) && typeof width !== 'number') throw invalid();
  return params;
}
