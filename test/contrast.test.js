import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const root = css.match(/:root\s*{([^}]*)}/)[1];
const variables = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*{([^}]*)}`));
  assert.ok(match, `rule ${selector} not found`);
  return match[1];
}

function resolveColor(value) {
  const variable = value.match(/^var\(--([\w-]+)\)$/);
  return variable ? resolveColor(variables[variable[1]]) : value;
}

function colorOf(selector) {
  return resolveColor(rule(selector).match(/(?:^|;|\s)color:\s*([^;]+);/)[1].trim());
}

function rgb(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

function blend(foreground, alpha, background) {
  return foreground.map((channel, index) => Math.round(channel * alpha + background[index] * (1 - alpha)));
}

function luminance(color) {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const warm = rgb(variables.warm);
const paper = rgb(variables.paper);
const backgrounds = {
  'sidebar (--warm)': warm,
  'editor and active note card (--paper)': paper,
  'hovered note card': blend(rgb(variables.ink), 0.05, warm),
  'search box': blend(paper, 0.7, warm),
};

test('secondary text colours meet WCAG AA 4.5:1 on every background they are used on', () => {
  for (const name of ['muted', 'faint']) {
    for (const [label, background] of Object.entries(backgrounds)) {
      const ratio = contrast(rgb(variables[name]), background);
      assert.ok(ratio >= 4.5, `--${name} on ${label}: ${ratio.toFixed(2)}`);
    }
  }
});

test('placeholders meet WCAG AA for their text size', () => {
  const search = colorOf('.search-box input::placeholder');
  assert.ok(contrast(rgb(search), backgrounds['search box']) >= 4.5, 'search placeholder');
  const content = colorOf('.content-input::placeholder');
  assert.ok(contrast(rgb(content), paper) >= 4.5, 'content placeholder (18px regular text)');
  // The title placeholder is large, bold text (34px+ at 750 weight), so 3:1 applies.
  assert.match(rule('.title-input'), /font-size: clamp\(34px/);
  const title = colorOf('.title-input::placeholder');
  assert.ok(contrast(rgb(title), paper) >= 3, 'title placeholder (large text)');
});

test('danger text meets 4.5:1 at rest and on hover', () => {
  const danger = rgb(variables.danger);
  assert.ok(contrast(danger, paper) >= 4.5);
  assert.ok(contrast(danger, blend([196, 63, 63], 0.06, paper)) >= 4.5);
});
