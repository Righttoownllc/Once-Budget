// Category icons. Stored as a budget setting "icon:<category id>" (synced like any setting, so no
// server change is needed). "-" means "no icon". Without a choice, an icon is suggested from the
// name; a name that already starts with an emoji ("☕ Coffee") gets none, so it isn't doubled.

const SUGGEST = [
  [/rent|mortgage|housing|home\b/i, '🏠'], [/electric|hydro|power|energy/i, '💡'], [/water|sewer/i, '🚰'],
  [/internet|wifi|broadband/i, '🌐'], [/phone|mobile|cell/i, '📱'], [/insurance/i, '🛡️'],
  [/grocer|food\b|supermarket/i, '🛒'], [/gas\b|fuel|petrol/i, '⛽'], [/dining|restaurant|eating out|takeout|take-out/i, '🍽️'],
  [/coffee|cafe/i, '☕'], [/household|home goods|supplies/i, '🧺'], [/stream|netflix|subscription/i, '📺'],
  [/hobb/i, '🎨'], [/car payment|auto loan|car loan/i, '🚙'], [/car|auto|vehicle|registration|smog/i, '🚗'],
  [/loan|debt|payoff|card/i, '💳'], [/emergency/i, '🆘'], [/vacation|travel|trip|holiday/i, '✈️'],
  [/saving|goal/i, '🐷'], [/gift|christmas|birthday/i, '🎁'], [/kid|child|daycare|school|tuition/i, '🧒'],
  [/pet|dog|cat\b|vet/i, '🐾'], [/health|medical|doctor|dental|pharmacy/i, '🩺'], [/gym|fitness|sport/i, '🏋️'],
  [/cloth|apparel|shoes/i, '👕'], [/fun|entertain|movie|game/i, '🎉'], [/paycheck|salary|income|wage/i, '💵'],
  [/charity|donat|church|tithe/i, '💝'], [/tax/i, '🧾'], [/beauty|hair|personal/i, '💇'], [/book|education/i, '📚'],
];
export const startsWithEmoji = s => /^\p{Extended_Pictographic}/u.test((s || '').trim());
export const suggestIcon = name => (startsWithEmoji(name) ? '' : SUGGEST.find(([re]) => re.test(name || ''))?.[1] || '');

/** The icon to show for a category ('' for none). */
export function catIcon(data, c) {
  if (!c) return '';
  const set = data?.prefs?.['icon:' + c.id];
  if (set === '-') return '';
  if (set) return set;
  return suggestIcon(c.name);
}

/** Choices in the icon picker. */
export const ICONS = ['🏠', '💡', '🚰', '🌐', '📱', '🛡️', '🛒', '⛽', '🍽️', '☕', '🍔', '🍕', '🧺', '📺', '🎮', '🎨', '🎵', '🚗', '🚙', '🚌', '🅿️',
  '💳', '🏦', '💵', '🆘', '🐷', '✈️', '🏖️', '🏕️', '🎁', '🎄', '🧒', '🎓', '📚', '🐾', '🩺', '💊', '🦷', '🏋️', '👕', '💇', '🎉', '🍿', '💝', '⛪', '🧾',
  '🔧', '🌱', '🧹', '👶', '💍', '🚲', '⚽', '🍷', '🛍️', '📦', '💻', '☁️', '🔒', '⭐'];

/** Inline icon before a name. */
export const Icon = ({ data, c }) => { const i = catIcon(data, c); return i ? <span class="cicon" aria-hidden="true">{i}</span> : null; };
