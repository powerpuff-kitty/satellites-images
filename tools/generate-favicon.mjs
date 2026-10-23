import { readFileSync, writeFileSync } from 'node:fs';
const themes = JSON.parse(readFileSync(new URL(import.meta.resolve('@powerpuff-kitty/tcsn-design-system/tokens/themes.json')), 'utf8'));
const theme = themes['satellites-images'];
const hex = token => '#' + token.$value.components.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const bg = hex(theme.bg), ink = hex(theme.ink);
writeFileSync(new URL('../apps/explorer/public/favicon.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="palette" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="${ink}"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#palette)"/></svg>\n`);
