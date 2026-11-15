// The texts, bundled by esbuild's text loader (build.mjs) from the repo's docs/legal/. Only the bundle imports this.
import privacy from '../../docs/legal/privacy.txt';
import terms from '../../docs/legal/terms.txt';

export const LEGAL_TEXT = { privacy, terms };
