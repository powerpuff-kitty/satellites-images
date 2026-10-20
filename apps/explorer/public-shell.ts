import { headerMarkup, supportButtonMarkup } from "@powerpuff-kitty/tcsn-design-system";

/** Build/dev response HTML uses the same canonical components as browser enhancement. */
export function satellitePublicShell(html: string): string {
  const header = headerMarkup({
    brand: "satellite images.",
    href: "./",
    actions: [{ label: "Contact", href: "https://tcsn.io/contact" }],
  }).replace("</nav>", supportButtonMarkup() + "</nav>");
  return html
    .replace(/(<header id="app-header" class="tcsn-shell__header">)[\s\S]*?(<\/header>)/, `$1${header}$2`)
    .replace(/(<p id="sidebar-copyright" class="sidebar-copyright">)[\s\S]*?(<\/p>)/, `$1© ${new Date().getFullYear()} TCSN$2`);
}
