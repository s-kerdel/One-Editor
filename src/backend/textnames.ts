// Which file names look like text (worth indexing / opening as text). Shared by the workspace and
// the indexer worker.
const TEXT_EXTS = new Set(
  (
    'md markdown mdx txt text rst adoc org log csv tsv json jsonc json5 yaml yml toml ini cfg conf env properties ' +
    'php phtml inc js mjs cjs jsx ts mts cts tsx vue svelte astro css scss sass less html htm xml svg xsl ' +
    'py rb go rs java kt kts scala c h cc cpp cxx hpp hh cs fs swift m mm dart lua pl pm r jl ex exs erl hrl ' +
    'clj cljs edn hs elm ml mli nim zig v sol sql graphql gql proto sh bash zsh fish ps1 psm1 bat cmd ' +
    'dockerfile makefile mk cmake gradle tf hcl nix lock gitignore gitattributes editorconfig htaccess twig blade'
  ).split(' '),
);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'changelog', '.gitignore', '.env', '.htaccess', '.editorconfig']);
export function isProbablyTextName(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTS.has(lower.slice(dot + 1));
}
